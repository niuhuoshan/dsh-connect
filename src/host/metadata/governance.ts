import type {
  MetadataProfile,
  MetricDefinition,
  MetricSuggestion,
} from '../../types.js'

export function recommendMetrics(profiles: MetadataProfile[], sourceId: string, existing: MetricDefinition[]): MetricSuggestion[] {
  const result: MetricSuggestion[] = []
  const known = new Set(existing.filter(metric => metric.sourceId === sourceId).map(metric => `${metric.profileId}:${metric.columnName}:${metric.aggregation}`))
  for (const profile of profiles) {
    if (profile.sourceId !== sourceId || profile.ignored) continue
    const identifier = profile.columns.find(column => column.primaryKey)
    if (!known.has(`${profile.id}::count`)) {
      result.push({
        profileId: profile.id,
        name: `${profile.objectName}_count`,
        term: `${profile.term || profile.objectName}数量`,
        description: `统计${profile.term || profile.objectName}记录数`,
        aggregation: 'count',
        columnName: '',
        expression: 'COUNT(*)',
        unit: '条',
        reason: '每个业务表都可提供记录数指标',
      })
    }
    for (const column of profile.columns) {
      if (column.primaryKey || !isNumeric(column.type) || known.has(`${profile.id}:${column.name}:sum`)) continue
      const label = profile.semanticColumns.find(item => item.name === column.name)?.term || column.comment || column.name
      const lower = column.name.toLowerCase()
      const aggregation = /(?:amount|price|cost|total|balance|quantity|count|num|score|points|金额|数量|余额|积分)/i.test(lower) ? 'sum' : 'avg'
      result.push({
        profileId: profile.id,
        name: `${profile.objectName}_${column.name}_${aggregation}`,
        term: `${profile.term || profile.objectName}${label}${aggregation === 'sum' ? '合计' : '平均值'}`,
        description: `${aggregation === 'sum' ? '汇总' : '计算平均'}字段 ${label}`,
        aggregation,
        columnName: column.name,
        expression: `${aggregation.toUpperCase()}(${quoteIdentifier(column.name)})`,
        unit: '',
        reason: `字段类型 ${column.type} 适合${aggregation === 'sum' ? '求和' : '求平均'}`,
      })
      if (result.length >= 50) return result
    }
    if (identifier === undefined && result.length >= 50) break
  }
  return result.slice(0, 50)
}

export function metadataYaml(profiles: MetadataProfile[], metrics: MetricDefinition[], sourceId: string): string {
  const lines = ['version: 1', `sourceId: ${yamlScalar(sourceId)}`, 'tables:']
  for (const profile of profiles.filter(item => item.sourceId === sourceId)) {
    lines.push(`  - id: ${yamlScalar(profile.id)}`, `    name: ${yamlScalar(`${profile.schemaName}.${profile.objectName}`)}`, `    type: ${yamlScalar(profile.objectType)}`, `    term: ${yamlScalar(profile.term)}`, `    description: ${yamlScalar(profile.description)}`, `    synonyms: ${yamlList(profile.synonyms)}`, `    tags: ${yamlList(profile.tags)}`, `    ignored: ${String(profile.ignored)}`, '    columns:')
    for (const column of profile.columns) {
      const semantic = profile.semanticColumns.find(item => item.name === column.name)
      lines.push(`      - name: ${yamlScalar(column.name)}`, `        type: ${yamlScalar(column.type)}`, `        nullable: ${String(column.nullable)}`, `        primaryKey: ${String(column.primaryKey)}`, `        term: ${yamlScalar(semantic?.term ?? column.comment ?? '')}`, `        description: ${yamlScalar(semantic?.description ?? '')}`, `        synonyms: ${yamlList(semantic?.synonyms ?? [])}`, `        enums: ${yamlList(semantic?.enums ?? [])}`)
    }
  }
  lines.push('metrics:')
  for (const metric of metrics.filter(item => item.sourceId === sourceId)) {
    lines.push(`  - id: ${yamlScalar(metric.id)}`, `    name: ${yamlScalar(metric.name)}`, `    term: ${yamlScalar(metric.term)}`, `    profileId: ${yamlScalar(metric.profileId)}`, `    aggregation: ${yamlScalar(metric.aggregation)}`, `    columnName: ${yamlScalar(metric.columnName)}`, `    expression: ${yamlScalar(metric.expression)}`, `    description: ${yamlScalar(metric.description)}`)
  }
  return `${lines.join('\n')}\n`
}
function isNumeric(type: string): boolean { return /(?:int|decimal|numeric|number|float|double|real|money|serial)/i.test(type) }
function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"` }
function yamlScalar(value: string): string { return JSON.stringify(value ?? '') }
function yamlList(values: string[]): string { return `[${values.map(yamlScalar).join(', ')}]` }
