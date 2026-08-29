import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconApiOutline14,
  IconCloseOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ApiAuthView,
  ApiDefinitionView,
  ApiExecutionResult,
  ApiMethod,
  ApiParameter,
  DataSourceView,
  DatabaseType,
  MetadataProfile,
  MetadataChangePage,
  ProfileJob,
  SqlQueryResult,
} from '../types.js'
import type { ConnectClient } from './rpc.js'
import clickhouseLogo from './assets/clickhouse.svg'
import mysqlLogo from './assets/mysql.svg'
import postgresqlLogo from './assets/postgresql.svg'

interface ConnectSettingsFace {
  connectClient: ConnectClient
}

export type ConnectSettingsProps = PropsRuntime<'settings.section'> & InjectFace<ConnectSettingsFace>

type Tab = 'sources' | 'apis'

export function ConnectSettings(props: ConnectSettingsProps) {
  const [tab, setTab] = useState<Tab>('sources')
  const [sources, setSources] = useState<DataSourceView[]>([])
  const [apis, setApis] = useState<ApiDefinitionView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sourceEditor, setSourceEditor] = useState<DataSourceView | 'new' | null>(null)
  const [apiEditor, setApiEditor] = useState<ApiDefinitionView | 'new' | null>(null)
  const [metadataSource, setMetadataSource] = useState<DataSourceView | null>(null)
  const [governanceSource, setGovernanceSource] = useState<DataSourceView | null>(null)
  const [testApi, setTestApi] = useState<ApiDefinitionView | null>(null)

  const loadSources = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      setSources(await props.connectClient.call<DataSourceView[]>('sources/list'))
      setError('')
    } catch (nextError) {
      setError(errorText(nextError))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [props.connectClient])

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [nextSources, nextApis] = await Promise.all([
        props.connectClient.call<DataSourceView[]>('sources/list'),
        props.connectClient.call<ApiDefinitionView[]>('apis/list'),
      ])
      setSources(nextSources)
      setApis(nextApis)
      setLoaded(true)
      setError('')
    } catch (nextError) {
      setError(errorText(nextError))
    } finally {
      setLoading(false)
    }
  }, [props.connectClient])

  useEffect(() => { if (!loaded) void loadAll() }, [loadAll, loaded])

  const scanning = sources.some(source => isActiveJob(source.latestJob))
  useEffect(() => {
    if (!scanning) return
    const timer = window.setInterval(() => { void loadSources(false) }, 1200)
    return () => { window.clearInterval(timer) }
  }, [loadSources, scanning])

  async function sourceAction(source: DataSourceView, action: 'test' | 'scan' | 'cancel' | 'model' | 'full'): Promise<void> {
    const key = `${source.id}:${action}`
    setBusy(key)
    setError('')
    setNotice('')
    try {
      if (action === 'test') {
        await props.connectClient.call('sources/test', { id: source.id })
        setNotice(`${source.name} 连接成功`)
      } else if (action === 'scan' || action === 'model' || action === 'full') {
        const mode = action === 'model' ? 'rebuild-ai' : action === 'full' ? 'full' : 'incremental'
        await props.connectClient.call('sources/scan', { sourceId: source.id, mode })
        setNotice(action === 'model' ? `${source.name} AI 建模已启动` : action === 'full' ? `${source.name} 全量重建已启动` : `${source.name} 元数据扫描已启动`)
      } else {
        await props.connectClient.call('sources/cancel', { sourceId: source.id })
        setNotice(`${source.name} 扫描已停止，已完成部分已保留`)
      }
      await loadSources(false)
    } catch (nextError) {
      setError(errorText(nextError))
    } finally {
      setBusy('')
    }
  }

  async function deleteSource(source: DataSourceView): Promise<void> {
    if (!window.confirm(`删除数据库“${source.name}”及其元数据？`)) return
    setBusy(`${source.id}:delete`)
    try {
      await props.connectClient.call('sources/delete', { id: source.id })
      await loadSources(false)
      setNotice(`${source.name} 已删除`)
    } catch (nextError) {
      setError(errorText(nextError))
    } finally {
      setBusy('')
    }
  }

  async function deleteApi(definition: ApiDefinitionView): Promise<void> {
    if (!window.confirm(`删除 HTTP API“${definition.name}”？`)) return
    setBusy(`${definition.id}:delete`)
    try {
      await props.connectClient.call('apis/delete', { id: definition.id })
      setApis(await props.connectClient.call<ApiDefinitionView[]>('apis/list'))
      setNotice(`${definition.name} 已删除`)
    } catch (nextError) {
      setError(errorText(nextError))
    } finally {
      setBusy('')
    }
  }

  const sourceCount = sources.length
  const apiCount = apis.length
  return (
    <section className="dshc-workbench">
      <header className="dshc-page-head">
        <div className="dshc-page-title"><h1>DSH连接器</h1><p>连接数据库，HTTP API 交给 Agent 自动调用。</p></div>
        <div className="dshc-page-summary">
          <span className="dshc-summary-item"><strong>{sourceCount}</strong><span>数据库</span></span>
          <span className="dshc-summary-item"><strong>{apiCount}</strong><span>HTTP API</span></span>
        </div>
      </header>
      <div className="dshc-body">
          <div className="dshc-toolbar">
            <div className="dshc-tabs" role="tablist" aria-label="DSH连接器设置">
              <button type="button" role="tab" className="dshc-tab" data-active={tab === 'sources'} aria-selected={tab === 'sources'} onClick={() => { setTab('sources') }}>
                数据库 {sourceCount > 0 ? `(${sourceCount})` : ''}
              </button>
              <button type="button" role="tab" className="dshc-tab" data-active={tab === 'apis'} aria-selected={tab === 'apis'} onClick={() => { setTab('apis') }}>
                HTTP API {apiCount > 0 ? `(${apiCount})` : ''}
              </button>
            </div>
            <button type="button" className="dshc-icon" title="刷新" aria-label="刷新" disabled={loading} onClick={() => { void loadAll() }}>
              <IconRefreshOutline16 />
            </button>
            <button type="button" className="dshc-primary" onClick={() => { tab === 'sources' ? setSourceEditor('new') : setApiEditor('new') }}>
              <IconPlusOutline16 size={14} />{tab === 'sources' ? '添加数据库' : '添加 API'}
            </button>
          </div>

          {error !== '' ? <p className="dshc-error" role="alert">{error}</p> : null}
          {notice !== '' ? <p className="dshc-notice" role="status">{notice}</p> : null}
          {loading && !loaded ? <LoadingState label="正在加载数据库和 HTTP API" /> : null}
          {loaded && tab === 'sources' ? (
            <DataSourceList
              sources={sources}
              busy={busy}
              onEdit={setSourceEditor}
              onMetadata={setMetadataSource}
              onGovernance={setGovernanceSource}
              onAction={(source, action) => { void sourceAction(source, action) }}
              onDelete={(source) => { void deleteSource(source) }}
            />
          ) : null}
          {loaded && tab === 'apis' ? (
            <ApiList
              apis={apis}
              busy={busy}
              onEdit={setApiEditor}
              onTest={setTestApi}
              onDelete={(definition) => { void deleteApi(definition) }}
            />
          ) : null}
      </div>

      <DataSourceEditor
        value={sourceEditor}
        onClose={() => { setSourceEditor(null) }}
        onSave={async payload => {
          await props.connectClient.call('sources/save', payload)
          await loadSources(false)
          setSourceEditor(null)
          setNotice(payload.id === undefined ? '数据库已添加' : '数据库已更新')
        }}
      />
      <ApiEditor
        value={apiEditor}
        onClose={() => { setApiEditor(null) }}
        onSave={async payload => {
          await props.connectClient.call('apis/save', payload)
          setApis(await props.connectClient.call<ApiDefinitionView[]>('apis/list'))
          setApiEditor(null)
          setNotice(payload.id === undefined ? 'HTTP API 已添加，可在对话中调用' : 'HTTP API 已更新')
        }}
      />
      <MetadataBrowser client={props.connectClient} source={metadataSource} onClose={() => { setMetadataSource(null) }} />
      <GovernancePanel client={props.connectClient} source={governanceSource} onClose={() => { setGovernanceSource(null) }} />
      <ApiTester client={props.connectClient} definition={testApi} onClose={() => { setTestApi(null) }} />
    </section>
  )
}

function DataSourceList(props: {
  sources: DataSourceView[]
  busy: string
  onEdit: (source: DataSourceView) => void
  onMetadata: (source: DataSourceView) => void
  onGovernance: (source: DataSourceView) => void
  onAction: (source: DataSourceView, action: 'test' | 'scan' | 'cancel' | 'model' | 'full') => void
  onDelete: (source: DataSourceView) => void
}) {
  if (props.sources.length === 0) return <div className="dshc-empty">暂无数据库</div>
  return <div className="dshc-card-grid">{props.sources.map(source => {
    const active = isActiveJob(source.latestJob)
    const progress = jobProgress(source.latestJob)
    return <article className="dshc-source-card" key={source.id}>
      <div className="dshc-source-card-head"><DatabaseLogo type={source.type} /><div className="dshc-source-card-title"><strong>{source.name}</strong><span>{databaseLabel(source.type)}</span></div><StatusBadge source={source} /></div>
      <p className="dshc-source-address">{source.host}:{source.port} / {source.database}</p>
      <div className="dshc-source-stats"><span><strong>{source.profileCount}</strong> 对象</span><span><strong>{source.aiProfileCount}</strong> AI 元数据</span><span>{source.credentialConfigured ? '凭据已配置' : '待配置凭据'}</span></div>
      {active ? <div className="dshc-progress"><span style={{ width: `${progress}%` }} /></div> : null}
      {active && source.latestJob?.currentObject !== undefined ? <p className="dshc-current-object">正在处理 {source.latestJob.currentObject}</p> : null}
      <div className="dshc-card-actions">
        <button type="button" className="dshc-secondary" disabled={props.busy !== ''} onClick={() => { props.onAction(source, 'test') }}>测试连接</button>
        {active ? <button type="button" className="dshc-secondary" disabled={props.busy !== ''} onClick={() => { props.onAction(source, 'cancel') }}><IconCloseOutline16 size={13} />停止</button> : <button type="button" className="dshc-secondary" disabled={!source.enabled || props.busy !== ''} onClick={() => { props.onAction(source, 'scan') }}><IconRefreshOutline16 size={13} />扫描</button>}
        <button type="button" className="dshc-primary" disabled={!source.enabled || !source.aiEnrichment || active || props.busy !== ''} onClick={() => { props.onAction(source, 'model') }}>AI 建模</button>
      </div>
      <div className="dshc-card-actions dshc-card-actions-muted"><button type="button" className="dshc-icon" title="浏览元数据" aria-label={`浏览 ${source.name} 元数据`} disabled={source.profileCount === 0} onClick={() => { props.onMetadata(source) }}><IconDataOutline16 /></button><button type="button" className="dshc-secondary" disabled={source.profileCount === 0} onClick={() => { props.onGovernance(source) }}>元数据</button><button type="button" className="dshc-icon" title="编辑" aria-label={`编辑 ${source.name}`} onClick={() => { props.onEdit(source) }}><IconEditOutline16 /></button><button type="button" className="dshc-icon" title="删除" aria-label={`删除 ${source.name}`} disabled={props.busy !== ''} onClick={() => { props.onDelete(source) }}><IconTrashOutline16 /></button><span className="dshc-row-meta">{source.aiEnrichment ? 'AI 已开启' : '仅物理识别'}</span></div>
    </article>
  })}</div>
}

function ApiList(props: {
  apis: ApiDefinitionView[]
  busy: string
  onEdit: (definition: ApiDefinitionView) => void
  onTest: (definition: ApiDefinitionView) => void
  onDelete: (definition: ApiDefinitionView) => void
}) {
  if (props.apis.length === 0) return <div className="dshc-empty">暂无 HTTP API</div>
  return <div className="dshc-card-grid">{props.apis.map(definition => <article className="dshc-api-card" key={definition.id}>
    <div className="dshc-source-card-head"><span className="dshc-api-method" data-method={definition.method}>{definition.method}</span><div className="dshc-source-card-title"><strong>{definition.name}</strong><span>{definition.baseUrl}{definition.pathTemplate}</span></div><span className="dshc-badge" data-tone={definition.enabled ? 'success' : undefined}><span className="dshc-dot" />{definition.enabled ? '已启用' : '已停用'}</span></div>
    <p className="dshc-api-description">{definition.description}</p><div className="dshc-source-stats"><span><strong>{definition.parameters.length}</strong> 个参数</span><span>{authLabel(definition.auth)}</span></div><code className="dshc-tool-name">{definition.toolName}</code>
    <div className="dshc-card-actions"><button type="button" className="dshc-secondary" disabled={props.busy !== ''} onClick={() => { props.onTest(definition) }}><IconApiOutline14 />测试请求</button><button type="button" className="dshc-secondary" onClick={() => { props.onEdit(definition) }}><IconEditOutline16 />编辑</button><button type="button" className="dshc-icon" title="删除" aria-label={`删除 ${definition.name}`} disabled={props.busy !== ''} onClick={() => { props.onDelete(definition) }}><IconTrashOutline16 /></button></div>
  </article>)}</div>
}

interface DataSourceDraft {
  id?: string
  name: string
  type: DatabaseType
  host: string
  port: number
  database: string
  username: string
  secret: string
  schemaInclude: string
  tls: boolean
  sampleRows: number
  aiEnrichment: boolean
  enabled: boolean
}

function DataSourceEditor(props: {
  value: DataSourceView | 'new' | null
  onClose: () => void
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const [draft, setDraft] = useState<DataSourceDraft>(() => emptyDataSource())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (props.value === null) return
    setDraft(props.value === 'new' ? emptyDataSource() : dataSourceDraft(props.value))
    setError('')
  }, [props.value])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await props.onSave({
        ...(draft.id === undefined ? {} : { id: draft.id }),
        name: draft.name,
        type: draft.type,
        host: draft.host,
        port: draft.port,
        database: draft.database,
        username: draft.username,
        ...(draft.secret.trim() === '' ? {} : { secret: draft.secret }),
        schemaInclude: draft.schemaInclude.split(',').map(value => value.trim()).filter(Boolean),
        tls: draft.tls,
        sampleRows: draft.sampleRows,
        aiEnrichment: draft.aiEnrichment,
        enabled: draft.enabled,
      })
    } catch (nextError) {
      setError(errorText(nextError))
    } finally {
      setSaving(false)
    }
  }

  const isNew = props.value === 'new'
  return (
    <Modal
      open={props.value !== null}
      onClose={saving ? () => {} : props.onClose}
      title={isNew ? '添加数据库' : '编辑数据库'}
      {...isNew ? {} : { description: '留空密码将保留现有凭据。' }}
      className="dshc-modal"
      contentClassName="dshc-modal-content"
      footer={(
        <div className="dshc-form-footer">
          {error !== '' ? <span className="dshc-form-error">{error}</span> : null}
          <button type="button" className="dshc-secondary" disabled={saving} onClick={props.onClose}>取消</button>
          <button type="submit" form="dshc-source-form" className="dshc-primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      )}
    >
      <form id="dshc-source-form" className="dshc-form" onSubmit={event => { void submit(event) }}>
        <div className="dshc-grid">
          <Field label="名称"><input className="dshc-input" required maxLength={100} value={draft.name} onChange={event => { setDraft({ ...draft, name: event.target.value }) }} /></Field>
          <div className="dshc-field dshc-field-wide">
            <span className="dshc-field-label">数据库类型</span>
            <div className="dshc-db-picker" role="radiogroup" aria-label="数据库类型">
              {(['mysql', 'postgresql', 'clickhouse'] as DatabaseType[]).map(type => <button key={type} type="button" role="radio" aria-checked={draft.type === type} className="dshc-db-option" data-active={draft.type === type} onClick={() => { setDraft({ ...draft, type, port: defaultPort(type) }) }}><DatabaseLogo type={type} /><span>{databaseLabel(type)}</span><small>{defaultPort(type)}</small></button>)}
            </div>
          </div>
          <Field label="主机"><input className="dshc-input" required value={draft.host} onChange={event => { setDraft({ ...draft, host: event.target.value }) }} /></Field>
          <Field label="端口"><input className="dshc-input" type="number" min={1} max={65535} required value={draft.port} onChange={event => { setDraft({ ...draft, port: Number(event.target.value) }) }} /></Field>
          <Field label="数据库"><input className="dshc-input" required value={draft.database} onChange={event => { setDraft({ ...draft, database: event.target.value }) }} /></Field>
          <Field label="用户名"><input className="dshc-input" required value={draft.username} onChange={event => { setDraft({ ...draft, username: event.target.value }) }} /></Field>
          <Field label={isNew ? '密码' : '新密码'}><input className="dshc-input" type="password" required={isNew} autoComplete="new-password" value={draft.secret} onChange={event => { setDraft({ ...draft, secret: event.target.value }) }} /></Field>
          <Field label="Schema 白名单" hint="逗号分隔；留空扫描全部可见 Schema"><input className="dshc-input" value={draft.schemaInclude} onChange={event => { setDraft({ ...draft, schemaInclude: event.target.value }) }} /></Field>
          <Field label="采样行数"><select className="dshc-select" value={draft.sampleRows} onChange={event => { setDraft({ ...draft, sampleRows: Number(event.target.value) }) }}><option value={0}>不采样</option><option value={1}>1 行</option><option value={2}>2 行</option><option value={3}>3 行</option></select></Field>
        </div>
        <div className="dshc-checks">
          <Check label="TLS" checked={draft.tls} onChange={value => { setDraft({ ...draft, tls: value }) }} />
          <Check label="AI 语义增强（DSH 默认模型）" checked={draft.aiEnrichment} onChange={value => { setDraft({ ...draft, aiEnrichment: value }) }} />
          <Check label="启用" checked={draft.enabled} onChange={value => { setDraft({ ...draft, enabled: value }) }} />
        </div>
      </form>
    </Modal>
  )
}

interface ApiDraft {
  id?: string
  name: string
  slug: string
  description: string
  method: ApiMethod
  baseUrl: string
  pathTemplate: string
  parameters: ApiParameter[]
  authType: ApiAuthView['type']
  authLocation: 'header' | 'query'
  authName: string
  authUsername: string
  secret: string
  timeoutMs: number
  maxResponseBytes: number
  responsePointer: string
  allowPrivateNetwork: boolean
  enabled: boolean
}

function ApiEditor(props: {
  value: ApiDefinitionView | 'new' | null
  onClose: () => void
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const [draft, setDraft] = useState<ApiDraft>(() => emptyApi())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (props.value === null) return
    setDraft(props.value === 'new' ? emptyApi() : apiDraft(props.value))
    setError('')
  }, [props.value])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await props.onSave({
        ...(draft.id === undefined ? {} : { id: draft.id }),
        name: draft.name,
        slug: draft.slug,
        description: draft.description,
        method: draft.method,
        baseUrl: draft.baseUrl,
        pathTemplate: draft.pathTemplate,
        parameters: draft.parameters,
        auth: authPayload(draft),
        ...(draft.secret.trim() === '' ? {} : { secret: draft.secret }),
        timeoutMs: draft.timeoutMs,
        maxResponseBytes: draft.maxResponseBytes,
        responsePointer: draft.responsePointer,
        allowPrivateNetwork: draft.allowPrivateNetwork,
        enabled: draft.enabled,
      })
    } catch (nextError) {
      setError(errorText(nextError))
    } finally {
      setSaving(false)
    }
  }

  const isNew = props.value === 'new'
  const authNeedsSecret = draft.authType !== 'none'
  return (
    <Modal
      open={props.value !== null}
      onClose={saving ? () => {} : props.onClose}
      title={isNew ? '添加 HTTP API' : '编辑 HTTP API'}
      {...isNew ? {} : { description: '留空密钥将保留现有凭据。' }}
      className="dshc-modal"
      contentClassName="dshc-modal-content"
      footer={(
        <div className="dshc-form-footer">
          {error !== '' ? <span className="dshc-form-error">{error}</span> : null}
          <button type="button" className="dshc-secondary" disabled={saving} onClick={props.onClose}>取消</button>
          <button type="submit" form="dshc-api-form" className="dshc-primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      )}
    >
      <form id="dshc-api-form" className="dshc-form" onSubmit={event => { void submit(event) }}>
        <div className="dshc-grid">
          <Field label="名称"><input className="dshc-input" required maxLength={100} value={draft.name} onChange={event => { setDraft({ ...draft, name: event.target.value }) }} /></Field>
          <Field label="工具标识" hint="小写字母开头，仅小写字母、数字和下划线"><input className="dshc-input" required pattern="[a-z][a-z0-9_]+" maxLength={48} value={draft.slug} onChange={event => { setDraft({ ...draft, slug: event.target.value.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_') }) }} /></Field>
          <Field label="方法"><select className="dshc-select" value={draft.method} onChange={event => { setDraft({ ...draft, method: event.target.value as ApiMethod }) }}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(method => <option key={method}>{method}</option>)}</select></Field>
          <Field label="基础 URL"><input className="dshc-input" type="url" required placeholder="https://api.example.com" value={draft.baseUrl} onChange={event => { setDraft({ ...draft, baseUrl: event.target.value }) }} /></Field>
          <Field label="路径模板" hint="路径参数使用 {name}"><input className="dshc-input" required value={draft.pathTemplate} onChange={event => { setDraft({ ...draft, pathTemplate: event.target.value }) }} /></Field>
          <Field label="JSON Pointer" hint="留空返回完整响应"><input className="dshc-input" placeholder="/data/items" value={draft.responsePointer} onChange={event => { setDraft({ ...draft, responsePointer: event.target.value }) }} /></Field>
          <Field label="超时（毫秒）"><input className="dshc-input" type="number" min={1000} max={120000} value={draft.timeoutMs} onChange={event => { setDraft({ ...draft, timeoutMs: Number(event.target.value) }) }} /></Field>
          <Field label="最大响应（字节）"><input className="dshc-input" type="number" min={1024} max={2097152} value={draft.maxResponseBytes} onChange={event => { setDraft({ ...draft, maxResponseBytes: Number(event.target.value) }) }} /></Field>
          <Field label="描述" wide><textarea className="dshc-textarea" required maxLength={1000} value={draft.description} onChange={event => { setDraft({ ...draft, description: event.target.value }) }} /></Field>
        </div>

        <div className="dshc-section-title"><strong>认证</strong></div>
        <div className="dshc-grid">
          <Field label="认证方式"><select className="dshc-select" value={draft.authType} onChange={event => { setDraft({ ...draft, authType: event.target.value as ApiAuthView['type'] }) }}><option value="none">无</option><option value="bearer">Bearer Token</option><option value="api-key">API Key</option><option value="basic">Basic Auth</option></select></Field>
          {draft.authType === 'api-key' ? <Field label="放置位置"><select className="dshc-select" value={draft.authLocation} onChange={event => { setDraft({ ...draft, authLocation: event.target.value as 'header' | 'query' }) }}><option value="header">Header</option><option value="query">Query</option></select></Field> : null}
          {draft.authType === 'api-key' ? <Field label="参数名称"><input className="dshc-input" required value={draft.authName} onChange={event => { setDraft({ ...draft, authName: event.target.value }) }} /></Field> : null}
          {draft.authType === 'basic' ? <Field label="用户名"><input className="dshc-input" required value={draft.authUsername} onChange={event => { setDraft({ ...draft, authUsername: event.target.value }) }} /></Field> : null}
          {authNeedsSecret ? <Field label={isNew ? '密钥' : '新密钥'}><input className="dshc-input" type="password" required={isNew} autoComplete="new-password" value={draft.secret} onChange={event => { setDraft({ ...draft, secret: event.target.value }) }} /></Field> : null}
        </div>

        <div className="dshc-section-title">
          <strong>工具参数</strong>
          <button type="button" className="dshc-secondary" onClick={() => { setDraft({ ...draft, parameters: [...draft.parameters, emptyParameter()] }) }}><IconPlusOutline16 size={13} />添加参数</button>
        </div>
        <div className="dshc-param-list">
          {draft.parameters.length === 0 ? <span className="dshc-row-meta">无参数</span> : null}
          {draft.parameters.map((parameter, index) => (
            <ParameterEditor
              key={index}
              parameter={parameter}
              onChange={next => { setDraft({ ...draft, parameters: replaceAt(draft.parameters, index, next) }) }}
              onDelete={() => { setDraft({ ...draft, parameters: draft.parameters.filter((_, itemIndex) => itemIndex !== index) }) }}
            />
          ))}
        </div>
        <div className="dshc-checks">
          <Check label="允许访问私有网络" checked={draft.allowPrivateNetwork} onChange={value => { setDraft({ ...draft, allowPrivateNetwork: value }) }} />
          <Check label="启用为 Agent 工具" checked={draft.enabled} onChange={value => { setDraft({ ...draft, enabled: value }) }} />
        </div>
      </form>
    </Modal>
  )
}

function ParameterEditor(props: { parameter: ApiParameter; onChange: (value: ApiParameter) => void; onDelete: () => void }) {
  return (
    <div className="dshc-param">
      <input className="dshc-input" required placeholder="参数名" value={props.parameter.name} onChange={event => { props.onChange({ ...props.parameter, name: event.target.value }) }} />
      <select className="dshc-select" value={props.parameter.location} onChange={event => { props.onChange({ ...props.parameter, location: event.target.value as ApiParameter['location'] }) }}><option value="path">Path</option><option value="query">Query</option><option value="header">Header</option><option value="body">Body</option></select>
      <select className="dshc-select" value={props.parameter.type} onChange={event => { props.onChange({ ...props.parameter, type: event.target.value as ApiParameter['type'] }) }}><option value="string">String</option><option value="number">Number</option><option value="integer">Integer</option><option value="boolean">Boolean</option><option value="json">JSON</option></select>
      <label className="dshc-check"><input type="checkbox" checked={props.parameter.required} onChange={event => { props.onChange({ ...props.parameter, required: event.target.checked }) }} />必填</label>
      <button type="button" className="dshc-icon" title="删除参数" aria-label="删除参数" onClick={props.onDelete}><IconTrashOutline16 /></button>
      <input className="dshc-input dshc-param-desc" placeholder="参数描述" maxLength={500} value={props.parameter.description} onChange={event => { props.onChange({ ...props.parameter, description: event.target.value }) }} />
    </div>
  )
}

function MetadataBrowser(props: { client: ConnectClient; source: DataSourceView | null; onClose: () => void }) {
  const [profiles, setProfiles] = useState<MetadataProfile[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadedSourceId, setLoadedSourceId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (props.source === null) return
    let live = true
    setLoading(true)
    setError('')
    void props.client.call<MetadataProfile[]>('metadata/list', { sourceId: props.source.id }).then(result => {
      if (!live) return
      setProfiles(result)
      setSelectedId(result[0]?.id ?? '')
      setLoadedSourceId(props.source?.id ?? '')
    }).catch(nextError => {
      if (live) setError(errorText(nextError))
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [props.client, props.source])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return profiles
    return profiles.filter(profile => `${profile.schemaName}.${profile.objectName} ${profile.term} ${profile.description} ${profile.tags.join(' ')}`.toLowerCase().includes(needle))
  }, [profiles, query])
  const selected = profiles.find(profile => profile.id === selectedId) ?? filtered[0]
  const pending = props.source !== null && (loading || (error === '' && loadedSourceId !== props.source.id))

  return (
    <Modal open={props.source !== null} onClose={props.onClose} title={props.source === null ? '元数据' : `${props.source.name} 元数据`} className="dshc-meta-modal" contentClassName="dshc-modal-content">
      {pending ? <LoadingState label="正在加载数据库元数据" /> : null}
      {error !== '' ? <p className="dshc-error">{error}</p> : null}
      {!pending && error === '' ? (
        <div className="dshc-meta-layout">
          <aside className="dshc-meta-side">
            <div className="dshc-meta-search"><label className="dshc-field"><span className="dshc-field-label">搜索</span><span className="dshc-search-wrap"><IconSearchOutline16 /><input className="dshc-input" value={query} onChange={event => { setQuery(event.target.value) }} /></span></label></div>
            <div className="dshc-meta-list">
              {filtered.map(profile => <button type="button" className="dshc-meta-item" data-active={profile.id === selected?.id} key={profile.id} onClick={() => { setSelectedId(profile.id) }}><strong>{profile.schemaName}.{profile.objectName}</strong><span>{profile.objectType} / {profile.columns.length} 列 / 置信度 {profile.confidence}</span></button>)}
              {filtered.length === 0 ? <div className="dshc-empty">无匹配结果</div> : null}
            </div>
          </aside>
          <MetadataDetail profile={selected} />
        </div>
      ) : null}
    </Modal>
  )
}

function MetadataDetail({ profile }: { profile: MetadataProfile | undefined }) {
  if (profile === undefined) return <div className="dshc-empty">暂无元数据</div>
  return (
    <section className="dshc-meta-detail">
      <h3>{profile.schemaName}.{profile.objectName}</h3>
      <span className="dshc-badge" data-tone={profile.ignored ? 'warn' : 'success'}><span className="dshc-dot" />{profile.ignored ? '默认忽略' : '可检索'} / {profile.confidence}</span>
      <p>{profile.description || profile.comment || '暂无描述'}</p>
      {profile.tags.length > 0 ? <p>{profile.tags.map(tag => `#${tag}`).join(' ')}</p> : null}
      <div className="dshc-detail-title">字段</div>
      <table className="dshc-table"><thead><tr><th>名称</th><th>类型</th><th>语义</th><th>约束</th></tr></thead><tbody>{profile.columns.map(column => {
        const semantic = profile.semanticColumns.find(item => item.name === column.name)
        return <tr key={column.name}><td>{column.name}</td><td>{column.type}</td><td>{semantic?.term ?? ''}<br />{semantic?.description ?? ''}</td><td>{column.primaryKey ? 'PK ' : ''}{column.nullable ? 'NULL' : 'NOT NULL'}{column.references === undefined ? null : <><br />FK → {column.references.schemaName}.{column.references.objectName}.{column.references.columnName}</>}</td></tr>
      })}</tbody></table>
      <div className="dshc-detail-title">DDL</div><pre className="dshc-code">{profile.ddl}</pre>
      {profile.sample.length > 0 ? <><div className="dshc-detail-title">脱敏采样</div><pre className="dshc-code">{JSON.stringify(profile.sample, null, 2)}</pre></> : null}
      <p>识别依据：{profile.confidenceReason || '规则识别'}</p>
    </section>
  )
}

function GovernancePanel(props: { client: ConnectClient; source: DataSourceView | null; onClose: () => void }) {
  type Section = 'metadata' | 'query' | 'history'
  const [section, setSection] = useState<Section>('metadata')
  const [profiles, setProfiles] = useState<MetadataProfile[]>([])
  const [changes, setChanges] = useState<MetadataChangePage['items']>([])
  const [changeTotal, setChangeTotal] = useState(0)
  const [changesHaveMore, setChangesHaveMore] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [sql, setSql] = useState('')
  const [queryResult, setQueryResult] = useState<SqlQueryResult | null>(null)
  const [queryError, setQueryError] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadedSourceId, setLoadedSourceId] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    if (props.source === null) return
    setLoading(true)
    setError('')
    try {
      const sourceId = props.source.id
      const nextProfiles = await props.client.call<MetadataProfile[]>('metadata/list', { sourceId })
      setProfiles(nextProfiles); setLoadedSourceId(sourceId)
      setChanges([]); setChangeTotal(0); setChangesHaveMore(false); setHistoryLoaded(false)
    } catch (nextError) { setError(errorText(nextError)) } finally { setLoading(false) }
  }

  useEffect(() => { if (props.source !== null) { setSection('metadata'); setQueryResult(null); setQueryError(''); void load() } }, [props.source])

  async function loadChanges(reset: boolean): Promise<void> {
    if (props.source === null || historyLoading) return
    setHistoryLoading(true); setError('')
    try {
      const offset = reset ? 0 : changes.length
      const response = await props.client.call<MetadataChangePage | MetadataChangePage['items']>('metadata/changes', { sourceId: props.source.id, offset, limit: 20 })
      const page = normalizeChangePage(response, offset, 20)
      setChanges(current => reset ? page.items : [...current, ...page.items])
      setChangeTotal(page.total); setChangesHaveMore(page.hasMore); setHistoryLoaded(true)
    } catch (nextError) { setError(errorText(nextError)) } finally { setHistoryLoading(false) }
  }

  async function downloadYaml(): Promise<void> {
    if (props.source === null) return
    setWorking(true); setError('')
    try {
      const yaml = await props.client.call<string>('metadata/yaml', { sourceId: props.source.id })
      const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${safeFilename(props.source.name)}-metadata.yaml`
      anchor.click()
      window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
    } catch (nextError) { setError(errorText(nextError)) } finally { setWorking(false) }
  }

  async function runQuery(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (props.source === null || sql.trim() === '') return
    setWorking(true); setQueryError(''); setQueryResult(null)
    try { setQueryResult(await props.client.call<SqlQueryResult>('sources/query', { sourceId: props.source.id, sql, limit: 100 })) } catch (nextError) { setQueryError(errorText(nextError)) } finally { setWorking(false) }
  }

  const governancePending = props.source !== null && (loading || (error === '' && loadedSourceId !== props.source.id))
  const sourceLoaded = props.source !== null && loadedSourceId === props.source.id

  return <Modal open={props.source !== null} onClose={props.onClose} title={props.source === null ? '元数据' : `${props.source.name} 元数据`} className="dshc-meta-modal" contentClassName="dshc-modal-content">
    {governancePending ? <LoadingState label="正在加载元数据" /> : null}
    {error !== '' ? <p className="dshc-error" role="alert">{error}</p> : null}
    {!governancePending && sourceLoaded ? <>
      <div className="dshc-tabs" role="tablist">
        {([['metadata', '元数据'], ['query', '只读 SQL'], ['history', '变更记录']] as Array<[Section, string]>).map(([key, label]) => <button type="button" role="tab" className="dshc-tab" data-active={section === key} aria-selected={section === key} onClick={() => { setSection(key); if (key === 'history' && !historyLoaded) void loadChanges(true) }} key={key}>{label}</button>)}
      </div>
      {section === 'metadata' ? <GovernanceMetadataEditor client={props.client} profiles={profiles} onSaved={load} /> : null}
      {section === 'query' ? <section className="dshc-governance-section"><form className="dshc-form" onSubmit={event => { void runQuery(event) }}><Field label="只读 SQL" wide hint="只允许 SELECT / WITH，最多返回 100 行"><textarea className="dshc-textarea dshc-sql-editor" value={sql} onChange={event => { setSql(event.target.value); setQueryError('') }} placeholder="SELECT ..." /></Field><button type="submit" className="dshc-primary" disabled={working || sql.trim() === ''}>执行查询</button></form>{queryResult !== null ? <><span className="dshc-badge" data-tone="success"><span className="dshc-dot" />{queryResult.rowCount} 行 · {queryResult.durationMs} ms{queryResult.truncated ? ' · 已截断' : ''}</span><pre className="dshc-test-result">{formatValue(queryResult.rows)}</pre></> : null}{queryError !== '' ? <p className="dshc-error dshc-query-error" role="alert">{queryError}</p> : null}</section> : null}
      {section === 'history' ? <section className="dshc-governance-section"><div className="dshc-section-title"><div><strong>变更记录</strong><span className="dshc-row-meta">已加载 {changes.length} / {changeTotal}</span></div><button type="button" className="dshc-secondary" disabled={working} onClick={() => { void downloadYaml() }}><IconDownloadOutline16 size={14} />导出 YAML</button></div>{changes.map(change => <div className="dshc-governance-row" key={change.id}><div><strong>{change.summary}</strong><small>{new Date(change.changedAt).toLocaleString('zh-CN')} · {change.action}</small></div></div>)}{historyLoading && changes.length === 0 ? <LoadingState label="正在加载变更记录" compact /> : null}{!historyLoading && historyLoaded && changes.length === 0 ? <div className="dshc-empty">暂无变更记录</div> : null}{changesHaveMore ? <button type="button" className="dshc-secondary dshc-load-more" disabled={historyLoading} onClick={() => { void loadChanges(false) }}>{historyLoading ? '加载中…' : '加载更多'}</button> : null}</section> : null}
    </> : null}
  </Modal>
}

function GovernanceMetadataEditor(props: { client: ConnectClient; profiles: MetadataProfile[]; onSaved: () => Promise<void> | void }) {
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'table' | 'fields'>('table')
  const profile = props.profiles.find(item => item.id === selected) ?? props.profiles[0]
  const [term, setTerm] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [synonyms, setSynonyms] = useState('')
  const [ignored, setIgnored] = useState(false)
  const [columnName, setColumnName] = useState('')
  const [columnTerm, setColumnTerm] = useState('')
  const [columnDescription, setColumnDescription] = useState('')
  const [columnSynonyms, setColumnSynonyms] = useState('')
  const [columnEnums, setColumnEnums] = useState('')
  const [columnRole, setColumnRole] = useState<'identifier' | 'dimension' | 'measure' | 'time' | 'unknown'>('unknown')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const selectedColumn = profile?.columns.find(column => column.name === columnName) ?? profile?.columns[0]
  const visibleProfiles = useMemo(() => { const query = search.trim().toLocaleLowerCase(); if (query === '') return props.profiles; return props.profiles.filter(item => `${item.schemaName}.${item.objectName} ${item.term} ${item.description} ${item.comment ?? ''}`.toLocaleLowerCase().includes(query)) }, [props.profiles, search])
  useEffect(() => { if (profile !== undefined) { setSelected(profile.id); setTerm(profile.term); setDescription(profile.description); setTags(profile.tags.join(', ')); setSynonyms(profile.synonyms.join(', ')); setIgnored(profile.ignored); const first = profile.columns[0]; setColumnName(first?.name ?? ''); setError('') } }, [profile?.id, profile?.editedAt])
  useEffect(() => { const semantic = profile?.semanticColumns.find(item => item.name === selectedColumn?.name); setColumnTerm(semantic?.term ?? selectedColumn?.comment ?? ''); setColumnDescription(semantic?.description ?? ''); setColumnSynonyms(semantic?.synonyms.join(', ') ?? ''); setColumnEnums(semantic?.enums.join(', ') ?? ''); setColumnRole(semantic?.role ?? (selectedColumn?.primaryKey || selectedColumn?.references !== undefined ? 'identifier' : 'unknown')) }, [profile?.id, selectedColumn?.name])
  if (profile === undefined) return <div className="dshc-empty">暂无元数据</div>
  const currentProfile = profile
  async function saveTable(event: FormEvent): Promise<void> { event.preventDefault(); setSaving(true); setError(''); try { await props.client.call('metadata/update', { id: currentProfile.id, term, description, tags: csv(tags), synonyms: csv(synonyms), ignored }); await props.onSaved() } catch (nextError) { setError(errorText(nextError)) } finally { setSaving(false) } }
  async function saveColumn(event: FormEvent): Promise<void> { event.preventDefault(); if (columnName === '') return; setSaving(true); setError(''); try { const semanticColumns = currentProfile.semanticColumns.filter(item => item.name !== columnName); semanticColumns.push({ name: columnName, term: columnTerm, description: columnDescription, synonyms: csv(columnSynonyms), enums: csv(columnEnums), role: columnRole }); await props.client.call('metadata/update', { id: currentProfile.id, semanticColumns }); await props.onSaved() } catch (nextError) { setError(errorText(nextError)) } finally { setSaving(false) } }
  return <section className="dshc-governance-layout"><aside className="dshc-governance-sidebar"><div className="dshc-table-search"><IconSearchOutline16 size={14} /><input value={search} onChange={event => { setSearch(event.target.value) }} placeholder="搜索表名或描述" aria-label="搜索表名或描述" /></div><div className="dshc-governance-table-list">{visibleProfiles.map(item => <button type="button" className="dshc-governance-table" data-active={item.id === currentProfile.id} aria-current={item.id === currentProfile.id ? 'true' : undefined} onClick={() => { setSelected(item.id) }} key={item.id}><strong>{item.schemaName}.{item.objectName}</strong><span>{item.description || item.term || item.comment || '暂无表描述'}</span></button>)}{visibleProfiles.length === 0 ? <div className="dshc-empty">未找到匹配的表</div> : null}</div></aside><div className="dshc-governance-content"><div className="dshc-governance-heading"><div><strong>{currentProfile.schemaName}.{currentProfile.objectName}</strong><span>{currentProfile.description || currentProfile.comment || '暂无表描述'}</span></div><span className="dshc-badge">{currentProfile.columns.length} 个字段</span></div><div className="dshc-tabs dshc-governance-tabs" role="tablist"><button type="button" role="tab" className="dshc-tab" data-active={tab === 'table'} aria-selected={tab === 'table'} onClick={() => { setTab('table') }}>表元数据</button><button type="button" role="tab" className="dshc-tab" data-active={tab === 'fields'} aria-selected={tab === 'fields'} onClick={() => { setTab('fields') }}>字段元数据</button></div>{error !== '' ? <p className="dshc-error" role="alert">{error}</p> : null}{tab === 'table' ? <form className="dshc-form dshc-governance-form" onSubmit={event => { void saveTable(event) }}><div className="dshc-grid"><Field label="业务名称"><input className="dshc-input" value={term} onChange={event => { setTerm(event.target.value) }} /></Field><Field label="同义词" hint="逗号分隔"><input className="dshc-input" value={synonyms} onChange={event => { setSynonyms(event.target.value) }} /></Field><Field label="表描述" wide><textarea className="dshc-textarea" value={description} onChange={event => { setDescription(event.target.value) }} /></Field><Field label="标签" hint="逗号分隔"><input className="dshc-input" value={tags} onChange={event => { setTags(event.target.value) }} /></Field></div><label className="dshc-check"><input type="checkbox" checked={ignored} onChange={event => { setIgnored(event.target.checked) }} />从 Agent 检索中忽略</label><button type="submit" className="dshc-primary dshc-form-action" disabled={saving}>{saving ? '保存中…' : '保存表元数据'}</button></form> : null}{tab === 'fields' ? <form className="dshc-form dshc-governance-form" onSubmit={event => { void saveColumn(event) }}><Field label="选择字段" wide><select className="dshc-select" value={columnName} onChange={event => { setColumnName(event.target.value) }}>{currentProfile.columns.map(column => <option key={column.name} value={column.name}>{column.name} · {column.type}{column.primaryKey ? ' · 主键' : ''}{column.references === undefined ? '' : ` · 外键 → ${column.references.schemaName}.${column.references.objectName}.${column.references.columnName}`}</option>)}</select></Field><div className="dshc-grid"><Field label="字段业务名称"><input className="dshc-input" value={columnTerm} onChange={event => { setColumnTerm(event.target.value) }} /></Field><Field label="字段用途"><select className="dshc-select" value={columnRole} onChange={event => { setColumnRole(event.target.value as typeof columnRole) }}><option value="identifier">标识/关联字段</option><option value="dimension">描述/分类字段</option><option value="measure">数值字段</option><option value="time">时间字段</option><option value="unknown">暂不确定</option></select></Field><Field label="字段同义词" hint="逗号分隔"><input className="dshc-input" value={columnSynonyms} onChange={event => { setColumnSynonyms(event.target.value) }} /></Field><Field label="枚举值" hint="逗号分隔"><input className="dshc-input" value={columnEnums} onChange={event => { setColumnEnums(event.target.value) }} /></Field><Field label="字段描述" wide><textarea className="dshc-textarea" value={columnDescription} onChange={event => { setColumnDescription(event.target.value) }} /></Field></div><button type="submit" className="dshc-primary dshc-form-action" disabled={saving || columnName === ''}>{saving ? '保存中…' : '保存字段元数据'}</button></form> : null}</div></section>
}

function csv(value: string): string[] { return value.split(',').map(item => item.trim()).filter(Boolean) }
function safeFilename(value: string): string { return value.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'metadata' }

function normalizeChangePage(response: unknown, offset: number, limit: number): MetadataChangePage {
  if (!Array.isArray(response)) {
    if (typeof response !== 'object' || response === null || !Array.isArray((response as MetadataChangePage).items)) throw new Error('变更记录响应格式无效')
    return response as MetadataChangePage
  }
  const items = response.slice(offset, offset + limit)
  return { items, offset, limit, total: response.length, hasMore: offset + limit < response.length }
}

function ApiTester(props: { client: ConnectClient; definition: ApiDefinitionView | null; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ApiExecutionResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setValues({})
    setResult(null)
    setError('')
  }, [props.definition])

  async function test(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (props.definition === null) return
    setTesting(true)
    setError('')
    setResult(null)
    try {
      const args: Record<string, unknown> = {}
      for (const parameter of props.definition.parameters) {
        const raw = values[parameter.name] ?? ''
        if (raw === '' && !parameter.required) continue
        args[parameter.name] = parseParameterValue(parameter, raw)
      }
      setResult(await props.client.call<ApiExecutionResult>('apis/test', { id: props.definition.id, args }))
    } catch (nextError) {
      setError(errorText(nextError))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      open={props.definition !== null}
      onClose={testing ? () => {} : props.onClose}
      title={props.definition === null ? '测试 HTTP API' : `测试 ${props.definition.name}`}
      className="dshc-modal"
      contentClassName="dshc-modal-content"
      footer={<div className="dshc-form-footer"><button type="button" className="dshc-secondary" disabled={testing} onClick={props.onClose}>关闭</button><button type="submit" form="dshc-api-test" className="dshc-primary" disabled={testing}>{testing ? '请求中…' : '发送请求'}</button></div>}
    >
      <form id="dshc-api-test" className="dshc-form" onSubmit={event => { void test(event) }}>
        <div className="dshc-grid">
          {props.definition?.parameters.map(parameter => (
            <Field key={parameter.name} label={`${parameter.name}${parameter.required ? ' *' : ''}`} hint={`${parameter.location} / ${parameter.type}`} wide={parameter.type === 'json'}>
              {parameter.type === 'boolean' ? <select className="dshc-select" required={parameter.required} value={values[parameter.name] ?? ''} onChange={event => { setValues({ ...values, [parameter.name]: event.target.value }) }}><option value="">未设置</option><option value="true">true</option><option value="false">false</option></select> : parameter.type === 'json' ? <textarea className="dshc-textarea" required={parameter.required} value={values[parameter.name] ?? ''} onChange={event => { setValues({ ...values, [parameter.name]: event.target.value }) }} /> : <input className="dshc-input" required={parameter.required} type={parameter.type === 'number' || parameter.type === 'integer' ? 'number' : 'text'} step={parameter.type === 'integer' ? 1 : 'any'} value={values[parameter.name] ?? ''} onChange={event => { setValues({ ...values, [parameter.name]: event.target.value }) }} />}
            </Field>
          ))}
        </div>
        {props.definition?.parameters.length === 0 ? <p className="dshc-row-meta">此 API 无动态参数</p> : null}
        {error !== '' ? <p className="dshc-error">{error}</p> : null}
        {result !== null ? <><span className="dshc-badge" data-tone="success"><span className="dshc-dot" />HTTP {result.status} / {result.durationMs} ms{result.truncated ? ' / 已截断' : ''}</span><pre className="dshc-test-result">{formatValue(result.body)}</pre></> : null}
      </form>
    </Modal>
  )
}

function Field(props: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <label className={`dshc-field${props.wide === true ? ' dshc-field-wide' : ''}`}><span>{props.label}</span>{props.children}{props.hint !== undefined ? <small>{props.hint}</small> : null}</label>
}

function Check(props: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="dshc-check"><input type="checkbox" checked={props.checked} onChange={event => { props.onChange(event.target.checked) }} />{props.label}</label>
}

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`dshc-loading${compact ? ' dshc-loading-compact' : ''}`} role="status"><span className="dshc-spinner" aria-hidden="true" /><span>{label}…</span></div>
}

function StatusBadge({ source }: { source: DataSourceView }) {
  const job = source.latestJob
  if (!source.enabled) return <span className="dshc-badge"><span className="dshc-dot" />已停用</span>
  if (job === undefined) return <span className="dshc-badge"><span className="dshc-dot" />{source.profileCount > 0 ? `已有 ${source.profileCount} 个元数据` : '未扫描'}</span>
  const tone = job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : undefined
  return <span className="dshc-badge" data-tone={tone}><span className="dshc-dot" />{jobStatus(job)}</span>
}

function DatabaseLogo({ type }: { type: DatabaseType }) {
  const logos: Record<DatabaseType, string> = { mysql: mysqlLogo, postgresql: postgresqlLogo, clickhouse: clickhouseLogo }
  return <span className={`dshc-db-logo dshc-db-logo-${type}`}><img src={logos[type]} alt="" /></span>
}

function databaseLabel(type: DatabaseType): string {
  return type === 'postgresql' ? 'PostgreSQL' : type === 'clickhouse' ? 'ClickHouse' : 'MySQL'
}

function emptyDataSource(): DataSourceDraft {
  return { name: '', type: 'mysql', host: '127.0.0.1', port: 3306, database: '', username: '', secret: '', schemaInclude: '', tls: false, sampleRows: 0, aiEnrichment: false, enabled: true }
}

function dataSourceDraft(source: DataSourceView): DataSourceDraft {
  return { id: source.id, name: source.name, type: source.type, host: source.host, port: source.port, database: source.database, username: source.username, secret: '', schemaInclude: source.schemaInclude.join(', '), tls: source.tls, sampleRows: source.sampleRows, aiEnrichment: source.aiEnrichment, enabled: source.enabled }
}

function emptyApi(): ApiDraft {
  return { name: '', slug: '', description: '', method: 'GET', baseUrl: '', pathTemplate: '/', parameters: [], authType: 'none', authLocation: 'header', authName: 'X-API-Key', authUsername: '', secret: '', timeoutMs: 30000, maxResponseBytes: 131072, responsePointer: '', allowPrivateNetwork: false, enabled: true }
}

function apiDraft(definition: ApiDefinitionView): ApiDraft {
  const auth = definition.auth
  return {
    id: definition.id,
    name: definition.name,
    slug: definition.slug,
    description: definition.description,
    method: definition.method,
    baseUrl: definition.baseUrl,
    pathTemplate: definition.pathTemplate,
    parameters: definition.parameters.map(parameter => ({ ...parameter })),
    authType: auth.type,
    authLocation: auth.type === 'api-key' ? auth.location : 'header',
    authName: auth.type === 'api-key' ? auth.name : 'X-API-Key',
    authUsername: auth.type === 'basic' ? auth.username : '',
    secret: '',
    timeoutMs: definition.timeoutMs,
    maxResponseBytes: definition.maxResponseBytes,
    responsePointer: definition.responsePointer,
    allowPrivateNetwork: definition.allowPrivateNetwork,
    enabled: definition.enabled,
  }
}

function emptyParameter(): ApiParameter {
  return { name: '', location: 'query', type: 'string', description: '', required: false }
}

function authPayload(draft: ApiDraft): Record<string, unknown> {
  if (draft.authType === 'none' || draft.authType === 'bearer') return { type: draft.authType }
  if (draft.authType === 'basic') return { type: 'basic', username: draft.authUsername }
  return { type: 'api-key', location: draft.authLocation, name: draft.authName }
}

function authLabel(auth: ApiAuthView): string {
  if (auth.type === 'none') return '无需认证'
  return `${auth.type} / ${auth.credentialConfigured ? '凭据已配置' : '凭据未配置'}`
}

function replaceAt<T>(values: T[], index: number, value: T): T[] {
  return values.map((item, itemIndex) => itemIndex === index ? value : item)
}

function defaultPort(type: DatabaseType): number {
  if (type === 'postgresql') return 5432
  if (type === 'clickhouse') return 8123
  return 3306
}

function isActiveJob(job: ProfileJob | undefined): boolean {
  return job?.status === 'queued' || job?.status === 'running'
}

function jobProgress(job: ProfileJob | undefined): number {
  if (job === undefined || job.total === 0) return 4
  return Math.max(4, Math.min(100, Math.round(job.processed / job.total * 100)))
}

function jobStatus(job: ProfileJob): string {
  if (job.status === 'queued') return '等待扫描'
  if (job.status === 'running') return `扫描中 ${job.processed}/${job.total || '?'}`
  if (job.status === 'completed') return '扫描完成'
  if (job.status === 'failed') return '扫描失败'
  return '扫描未完成'
}

function parseParameterValue(parameter: ApiParameter, raw: string): unknown {
  if (parameter.type === 'string') return raw
  if (parameter.type === 'boolean') return raw === 'true'
  if (parameter.type === 'number' || parameter.type === 'integer') {
    const value = Number(raw)
    if (!Number.isFinite(value) || (parameter.type === 'integer' && !Number.isSafeInteger(value))) throw new Error(`${parameter.name} 不是有效的${parameter.type === 'integer' ? '整数' : '数字'}`)
    return value
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`${parameter.name} 不是有效的 JSON`)
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
