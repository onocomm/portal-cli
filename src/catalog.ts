export interface OperationParameter {
  name: string;
  type: 'string' | 'integer' | 'boolean';
  required: boolean;
  description: string;
}

export interface Operation {
  name: string;
  description: string;
  query: string;
  field: string;
  parameters: readonly OperationParameter[];
  paginated: boolean;
}

const graphqlTypes = { string: 'String', integer: 'Int', boolean: 'Boolean' } as const;

function parameter(
  name: string,
  description: string,
  type: OperationParameter['type'] = 'string',
  required = true,
): OperationParameter {
  return { name, type, required, description };
}

// Only fixed, reviewed selections are exposed; pagination variables belong to the runner.
function operation(
  name: string,
  description: string,
  field: string,
  selection: string,
  parameters: readonly OperationParameter[] = [],
  paginated = false,
): Operation {
  const variables = paginated
    ? [...parameters, parameter('limit', '', 'integer', false), parameter('nextToken', '', 'string', false)]
    : parameters;
  const declarations = variables.map(p => `$${p.name}: ${graphqlTypes[p.type]}${p.required ? '!' : ''}`);
  const argumentsList = variables.map(p => `${p.name}: $${p.name}`);
  const signature = declarations.length ? `(${declarations.join(', ')})` : '';
  const argumentsText = argumentsList.length ? `(${argumentsList.join(', ')})` : '';
  const result = paginated ? `items { ${selection} } nextToken` : selection;
  return {
    name,
    description,
    query: `query ${field}${signature} { ${field}${argumentsText} { ${result} } }`,
    field,
    parameters,
    paginated,
  };
}

function pair(
  name: string,
  label: string,
  listField: string,
  getField: string,
  key: OperationParameter,
  summary: string,
  detail = summary,
  listParameters: readonly OperationParameter[] = [],
): readonly Operation[] {
  return [
    operation(`${name}.list`, `${label}の一覧を取得`, listField, summary, listParameters, true),
    operation(`${name}.get`, `${label}の詳細を取得`, getField, detail, [key]),
  ];
}

// Reviewed against Portal frontend/src/@onocomm-system and backend/schema/merged-schema.graphql.
// Authentication and customer authorization remain the Portal API's responsibility.
export const operations: readonly Operation[] = [
  operation('auth.me', 'ログイン中のPortal利用者を取得', 'getAuthUser',
    'user_id user_name email customer_no customer_name customer_group admin_flag status'),
  ...pair('domain', 'ドメイン契約', 'scanDomain', 'getDomain',
    parameter('domain_name', 'ドメイン名'),
    'domain_name customer_no customer_name domain_kbn expiration status price_notax',
    'domain_name customer_no customer_name domain_kbn expiration status price_notax contract_years nameserver billing_date bill_start bill_end'),
  ...pair('customer', '顧客情報', 'scanCustomer', 'getCustomer',
    parameter('customer_no', '顧客番号'),
    'customer_no customer_name customer_name_furi contract_kbn',
    'customer_no customer_name customer_name_furi customer_name_en contract_kbn person_section person_name person_mail tech_name tech_mail invoice_pay_kbn invoice_mail_flag'),
  ...pair('ssl', 'SSL証明書契約', 'scanSSL', 'getSSL',
    parameter('ssl_name', 'SSL証明書名'),
    'ssl_name customer_no customer_name ssl_kbn status expiration price_notax',
    'ssl_name customer_no customer_name ssl_kbn status expiration price_notax contract_months target_type target_server setup_date acme_auto_renew acme_migration_status'),
  ...pair('aws', 'AWS契約', 'scanAWS', 'getAWS',
    parameter('account_no', 'AWSアカウント番号'),
    'account_no account_name customer_no customer_name status contract_date',
    'account_no account_name customer_no customer_name status contract_date payment_service organization_flag aws_support { support_name contract_date price_notax status } aws_discount { percent status }'),
  ...pair('mail', 'メール契約', 'scanMail', 'getMail',
    parameter('domain_name', 'メール契約のドメイン名'),
    'domain_name customer_no customer_name hostname contract_type pricing_plan status disk disk_use',
    'domain_name customer_no customer_name hostname hosting_platform contract_type pricing_plan status disk disk_use disk_free disk_per price_notax contract_date mail_host_sync_status'),
  ...pair('bill', '課金契約', 'scanBill', 'getBill',
    parameter('bill_no', '課金契約番号'),
    'bill_no customer_no customer_name title total_price_notax status contract_date',
    'bill_no customer_no customer_name title total_price_notax status contract_date bill_start bill_end details { details price_notax piece piece_type sub_price_notax sort }'),
  ...pair('invoice', '請求書', 'queryInvoice', 'getInvoice',
    parameter('invoice_no', '請求書番号'),
    'invoice_no customer_no customer_name date_invoice date_payment total_price total_price_notax total_tax invoice_flag',
    'invoice_no customer_no customer_name date_invoice date_payment total_price total_price_notax total_tax invoice_flag pay_kbn eligible_invoice details { details price_notax piece piece_type sub_price_notax tax tax_per sort }',
    [parameter('invoice_flag', '請求区分（Portalのinvoice_flag）'),
      parameter('start_date', '検索開始日（Portalの整数日付）', 'integer'),
      parameter('end_date', '検索終了日（Portalの整数日付）', 'integer')]),
  ...pair('quotation', '見積書', 'scanQuotation', 'getQuotation',
    parameter('quotation_no', '見積番号'),
    'quotation_no customer_no customer_name title date_quotation date_limit i_total_price m_total_price',
    'quotation_no customer_no customer_name title date_quotation date_limit i_total_price m_total_price i_total_price_notax m_total_price_notax details { details i_price_notax m_price_notax piece piece_type sort }'),
  ...pair('order', '注文', 'scanOrder', 'getOrder',
    parameter('order_no', '注文番号'),
    'order_no customer_no customer_name title date_order i_total_price m_total_price',
    'order_no customer_no customer_name title date_order i_total_price m_total_price i_total_price_notax m_total_price_notax target target_no'),
  ...pair('server', 'サーバー契約', 'scanServer', 'getServer',
    parameter('server_no', 'サーバー契約番号'),
    'server_no customer_no customer_name server_name server_type status instance_type total_price_notax',
    'server_no customer_no customer_name server_name server_type status account_no instance_id instance_type total_price_notax fqdn ip os contract_date'),
  ...pair('serverless', 'サーバーレス契約', 'scanServerless', 'getServerless',
    parameter('system_name', 'システム名'),
    'system_name system_name_full customer_no customer_name status price_notax',
    'system_name system_name_full customer_no customer_name status price_notax disk_num contract_date bill_start bill_end bill_cycle'),
  ...pair('storage', 'ストレージ契約', 'scanStorage', 'getStorage',
    parameter('storage_id', 'ストレージID'),
    'storage_id customer_no customer_name title status file_size_use file_num_use',
    'storage_id customer_no customer_name title status file_size_use file_num_use file_size_limit file_num_limit price_notax read_only contract_date'),
  ...pair('ns53', 'NS53契約', 'scanNS53', 'getNS53',
    parameter('ns53_no', 'NS53契約番号'),
    'ns53_no customer_no customer_name title status domain_num record_num',
    'ns53_no customer_no customer_name title status domain_num record_num price_notax contract_date bill_start bill_end'),
  ...pair('onocomm-members', 'オノコムメンバーズ契約', 'scanOnocommMembers', 'getOnocommMembers',
    parameter('contract_no', '契約番号'),
    'contract_no customer_no customer_name plan status price_notax contract_date contract_end_date',
    'contract_no customer_no customer_name plan status price_notax contract_date contract_end_date free_trial_end_date portal_user_limit qa_monthly_limit work_support_hours aws_discount_rate meeting_type poc_support_type'),
  ...pair('work-report', '作業報告書', 'queryWorkReport', 'getWorkReport',
    parameter('reportId', '作業報告書ID'),
    'reportId reportNumber customer_no status createdDate workStartDate workEndDate workerName',
    'reportId reportNumber customer_no status createdDate workStartDate workStartTime workEndDate workEndTime workerName workContent otherNotes createdAt updatedAt',
    [parameter('customer_no', '顧客番号')]),
  operation('announcement.list', 'お知らせ一覧を取得', 'queryAnnouncement',
    'announcement_id title content open_at close_at is_modal is_top_page status date_edit', [], true),
  operation('support-case.list', 'サポートケース一覧を検索', 'querySupportCaseV2',
    'case_id case_number customer_no account_no type subject status user_name date_add date_edit', [
      parameter('account_no', 'AWSアカウント番号で絞り込み', 'string', false),
      parameter('status', 'ケース状態で絞り込み', 'string', false),
      parameter('start_date', '検索開始日（Portalの整数日付）', 'integer', false),
      parameter('end_date', '検索終了日（Portalの整数日付）', 'integer', false),
    ], true),
  operation('support-case.get', 'サポートケースの詳細を取得', 'getSupportCase',
    'case_id case_number customer_no account_no type subject status user_name text_value date_add date_edit revision',
    [parameter('case_id', 'ケースID')]),
  operation('support-case.by-number', 'サポートケース番号からケースIDを検索', 'getSupportCaseByNumber',
    'case_id case_number', [parameter('case_number', 'サポートケース番号（6文字）')]),
  operation('support-case.comments', 'サポートケースのコメント一覧を取得', 'querySupportCaseComment',
    'case_id date user_name customer_no account_no text_value onocomm_flag ai_flag',
    [parameter('case_id', 'ケースID')], true),
];

export function getOperation(name: string): Operation | undefined {
  return operations.find(operation => operation.name === name);
}
