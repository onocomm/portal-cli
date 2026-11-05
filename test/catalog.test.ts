import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildSchema,
  getNamedType,
  isListType,
  isNonNullType,
  isObjectType,
  Kind,
  parse,
  print,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import type { FieldNode, GraphQLField } from 'graphql';
import { operations, getOperation } from '../src/catalog.js';

const fixturePath = new URL('./fixtures/portal-client-schema.graphql', import.meta.url);
const fixture = buildSchema(readFileSync(fixturePath, 'utf8'));

// Only explicit opt-in reads a private schema; public CI needs no sibling checkout.
function loadSchema(path: string) {
  const source = readFileSync(path, 'utf8');
  const declared = new Set(parse(source).definitions.flatMap(definition =>
    'name' in definition && definition.name ? [definition.name.value] : []));
  const appSyncDefinitions = ([
    ['AWSJSON', 'scalar AWSJSON'],
    ['AWSDateTime', 'scalar AWSDateTime'],
    ['aws_subscribe', 'directive @aws_subscribe(mutations: [String!]!) on FIELD_DEFINITION'],
  ] as const).filter(([name]) => !declared.has(name)).map(([, definition]) => definition).join('\n');
  return buildSchema(`${appSyncDefinitions}\n${source}`);
}

const schema = process.env.PORTAL_SCHEMA_PATH === undefined
  ? fixture
  : loadSchema(process.env.PORTAL_SCHEMA_PATH);
const queryFields = schema.getQueryType()!.getFields();
const graphqlTypes = { string: 'String', integer: 'Int', boolean: 'Boolean' } as const;
const pairs = [
  'domain', 'customer', 'ssl', 'aws', 'mail', 'bill', 'invoice', 'quotation',
  'order', 'server', 'serverless', 'storage', 'ns53', 'onocomm-members', 'work-report',
];
const allowedFields = new Set([
  'getAuthUser', 'scanDomain', 'getDomain', 'scanCustomer', 'getCustomer',
  'scanSSL', 'getSSL', 'scanAWS', 'getAWS', 'scanMail', 'getMail',
  'scanBill', 'getBill', 'queryInvoice', 'getInvoice', 'scanQuotation', 'getQuotation',
  'scanOrder', 'getOrder', 'scanServer', 'getServer', 'scanServerless', 'getServerless',
  'scanStorage', 'getStorage', 'scanNS53', 'getNS53', 'scanOnocommMembers',
  'getOnocommMembers', 'queryWorkReport', 'getWorkReport', 'queryAnnouncement',
  'querySupportCaseV2', 'getSupportCase', 'getSupportCaseByNumber', 'querySupportCaseComment',
]);
const forbiddenName = /password|passwd|secret|credential|private_?key|access_?key|auth_code|auth_user_id|update_user|mail_admin_authorization_id/i;

test('公開fixtureは選択フィールドと使用引数のみを含み、参照スキーマの型と一致する', () => {
  const used = new Map<string, Map<string, Set<string>>>();
  const usedTypes = new Set<string>();
  for (const operation of operations) {
    const info = new TypeInfo(schema);
    visit(parse(operation.query), visitWithTypeInfo(info, {
      Field(node) {
        const parent = info.getParentType();
        const field = info.getFieldDef();
        assert.ok(parent && field);
        usedTypes.add(parent.name);
        usedTypes.add(getNamedType(field.type).name);
        if (!used.has(parent.name)) used.set(parent.name, new Map());
        const fields = used.get(parent.name)!;
        if (!fields.has(field.name)) fields.set(field.name, new Set());
        const argumentsUsed = fields.get(field.name)!;
        for (const argument of node.arguments ?? []) {
          argumentsUsed.add(argument.name.value);
          const argumentDefinition = field.args.find(value => value.name === argument.name.value);
          assert.ok(argumentDefinition);
          usedTypes.add(getNamedType(argumentDefinition.type).name);
        }
      },
    }));
  }
  // GraphQL always installs Boolean/String for its built-in directives.
  const fixtureTypes = Object.values(fixture.getTypeMap()).filter(type => !type.name.startsWith('__'));
  assert.deepEqual(fixtureTypes.map(type => type.name).sort(), [...new Set([...usedTypes, 'Boolean', 'String'])].sort());
  assert.equal(fixture.getMutationType(), undefined);
  assert.equal(fixture.getSubscriptionType(), undefined);
  for (const [typeName, fields] of used) {
    const actual = fixture.getType(typeName);
    const expected = schema.getType(typeName);
    assert.ok(isObjectType(actual) && isObjectType(expected));
    assert.deepEqual(Object.keys(actual.getFields()).sort(), [...fields.keys()].sort(), typeName);
    for (const [fieldName, args] of fields) {
      const fixtureField: GraphQLField<unknown, unknown> = actual.getFields()[fieldName]!;
      const sourceField: GraphQLField<unknown, unknown> = expected.getFields()[fieldName]!;
      const label = `${typeName}.${fieldName}`;
      assert.doesNotMatch(fieldName, forbiddenName);
      assert.equal(String(fixtureField.type), String(sourceField.type), label);
      assert.deepEqual(fixtureField.args.map(arg => arg.name).sort(), [...args].sort(), label);
      for (const argument of fixtureField.args) {
        const sourceArgument = sourceField.args.find(arg => arg.name === argument.name)!;
        assert.doesNotMatch(argument.name, forbiddenName);
        assert.equal(String(argument.type), String(sourceArgument.type), `${label}(${argument.name})`);
        assert.deepEqual(argument.defaultValue, sourceArgument.defaultValue);
      }
    }
  }
});

test('主要15ドメインの一覧と詳細および必須操作を公開する', () => {
  assert.ok(pairs.length >= 10);
  for (const domain of pairs) {
    assert.equal(getOperation(`${domain}.list`)?.paginated, true);
    assert.equal(getOperation(`${domain}.get`)?.paginated, false);
  }
  assert.equal(getOperation('auth.me')?.field, 'getAuthUser');
  assert.equal(getOperation('support-case.by-number')?.field, 'getSupportCaseByNumber');
  assert.equal(getOperation('support-case.comments')?.field, 'querySupportCaseComment');
  assert.equal(operations.length, allowedFields.size);
});

test('操作名とルートフィールドは重複せず、検索は完全一致する', () => {
  assert.equal(new Set(operations.map(operation => operation.name)).size, operations.length);
  assert.equal(new Set(operations.map(operation => operation.field)).size, operations.length);
  for (const operation of operations) {
    assert.match(operation.name, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
    assert.ok(operation.description.trim());
    assert.equal(getOperation(operation.name), operation);
  }
  for (const name of ['', 'domain', 'DOMAIN.LIST', 'domain.list ', '__proto__', 'constructor', 'rawGraphQL', 'user.list']) {
    assert.equal(getOperation(name), undefined);
  }
});

for (const operation of operations) {
  test(`${operation.name}: queryのみで参照スキーマに適合する`, () => {
    const document = parse(operation.query);
    assert.equal(document.definitions.length, 1);
    const definition = document.definitions[0]!;
    assert.equal(definition.kind, Kind.OPERATION_DEFINITION);
    if (definition.kind !== Kind.OPERATION_DEFINITION) assert.fail('Expected an operation');
    assert.equal(definition.operation, 'query');
    assert.ok(definition.name);
    assert.deepEqual(validate(schema, document).map(error => error.message), []);
    assert.equal(definition.selectionSet.selections.length, 1);
    const root = definition.selectionSet.selections[0]!;
    assert.equal(root.kind, Kind.FIELD);
    if (root.kind !== Kind.FIELD) assert.fail('Expected a root field');
    assert.equal(root.name.value, operation.field);
    assert.ok(allowedFields.has(root.name.value));

    visit(document, {
      Field(node) {
        assert.equal(node.alias, undefined);
        assert.doesNotMatch(node.name.value, forbiddenName);
        assert.ok(!node.name.value.startsWith('__'));
      },
      Argument(node) { assert.doesNotMatch(node.name.value, forbiddenName); },
      Variable(node) { assert.doesNotMatch(node.name.value, forbiddenName); },
      Directive() { assert.fail('Directives are not exposed'); },
      FragmentSpread() { assert.fail('Fragments are not exposed'); },
      InlineFragment() { assert.fail('Fragments are not exposed'); },
      SelectionSet(node) {
        const fields = node.selections.filter((selection): selection is FieldNode => selection.kind === Kind.FIELD);
        assert.equal(new Set(fields.map(field => field.name.value)).size, fields.length);
      },
    });
  });

  test(`${operation.name}: パラメーター・変数・引数の型と必須指定が一致する`, () => {
    const definition = parse(operation.query).definitions[0]!;
    if (definition.kind !== Kind.OPERATION_DEFINITION) assert.fail('Expected an operation');
    const root = definition.selectionSet.selections[0]!;
    if (root.kind !== Kind.FIELD) assert.fail('Expected a root field');
    const field = queryFields[operation.field]!;
    const definitions = definition.variableDefinitions ?? [];
    const parameters = operation.parameters;
    assert.equal(new Set(parameters.map(parameter => parameter.name)).size, parameters.length);
    const expected = parameters.map(parameter => ({
      name: parameter.name,
      type: `${graphqlTypes[parameter.type]}${parameter.required ? '!' : ''}`,
    }));
    if (operation.paginated) expected.push({ name: 'limit', type: 'Int' }, { name: 'nextToken', type: 'String' });
    assert.deepEqual(definitions.map(variable => ({ name: variable.variable.name.value, type: print(variable.type) })), expected);
    assert.deepEqual((root.arguments ?? []).map(argument => argument.name.value), expected.map(variable => variable.name));
    for (const argument of root.arguments ?? []) {
      assert.equal(argument.value.kind, Kind.VARIABLE);
      if (argument.value.kind !== Kind.VARIABLE) assert.fail('Expected a variable argument');
      assert.equal(argument.value.name.value, argument.name.value);
    }
    for (const variable of definitions) {
      assert.equal(variable.defaultValue, undefined);
      const argument = field.args.find(argument => argument.name === variable.variable.name.value);
      assert.ok(argument);
      assert.equal(print(variable.type), String(argument.type));
    }
    for (const parameter of parameters) {
      assert.ok(parameter.description.trim());
      assert.ok(['string', 'integer', 'boolean'].includes(parameter.type));
      assert.equal(typeof parameter.required, 'boolean');
      assert.ok(!['limit', 'nextToken', 'update_user', 'auth_user_id'].includes(parameter.name));
    }
  });

  test(`${operation.name}: items/nextTokenのConnectionのみページングする`, () => {
    const definition = parse(operation.query).definitions[0]!;
    if (definition.kind !== Kind.OPERATION_DEFINITION) assert.fail('Expected an operation');
    const root = definition.selectionSet.selections[0]!;
    if (root.kind !== Kind.FIELD) assert.fail('Expected a root field');
    const result = getNamedType(queryFields[operation.field]!.type);
    assert.ok(isObjectType(result));
    const fields = result.getFields();
    const connection = Boolean(fields.items && fields.nextToken);
    assert.equal(operation.paginated, connection);
    const selection = root.selectionSet!.selections;
    if (connection) {
      assert.deepEqual(selection.map(field => field.kind === Kind.FIELD ? field.name.value : ''), ['items', 'nextToken']);
      const itemsType = fields.items!.type;
      assert.ok(isListType(isNonNullType(itemsType) ? itemsType.ofType : itemsType));
      assert.equal(String(fields.nextToken!.type), 'String');
      const items = selection[0]!;
      assert.equal(items.kind, Kind.FIELD);
      if (items.kind !== Kind.FIELD) assert.fail('Expected items');
      assert.ok(items.selectionSet!.selections.length >= 2);
    } else {
      assert.ok(selection.length >= 2);
      assert.ok(!selection.some(field => field.kind === Kind.FIELD && field.name.value === 'nextToken'));
    }
  });
}

test('請求書の検索条件は必須、サポートケースの絞り込みは任意', () => {
  assert.deepEqual(getOperation('invoice.list')!.parameters.map(({ name, type, required }) => ({ name, type, required })), [
    { name: 'invoice_flag', type: 'string', required: true },
    { name: 'start_date', type: 'integer', required: true },
    { name: 'end_date', type: 'integer', required: true },
  ]);
  assert.ok(getOperation('support-case.list')!.parameters.every(parameter => !parameter.required));
  assert.deepEqual(getOperation('auth.me')!.parameters, []);
});
