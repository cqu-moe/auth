# 同步耗时图表查询变更

日期：2026-09-22。PostHog项目608620，图表11927312（BjptXzwO）。

仅保存图表定义，不包含事件级用户数据。

## 修改前

```json
{
  "id": 11927312,
  "name": "同步耗时 p95",
  "description": "30 天 production schedule_sync_completed 的 duration_ms p95；分母为终态 run。",
  "query": {
    "kind": "InsightVizNode",
    "source": {
      "kind": "TrendsQuery",
      "series": [
        {
          "kind": "EventsNode",
          "math": "p95",
          "name": "p95 duration",
          "event": "schedule_sync_completed",
          "properties": [
            {
              "key": "environment",
              "type": "event",
              "value": [
                "production"
              ],
              "operator": "exact"
            }
          ],
          "math_property": "duration_ms"
        }
      ],
      "version": 4,
      "interval": "day",
      "dateRange": {
        "date_from": "-30d",
        "explicitDate": false,
        "excludeIncompletePeriods": false
      },
      "properties": [],
      "trendsFilter": {
        "display": "ActionsLineGraph",
        "showLegend": false,
        "hideWeekends": false,
        "metricSummary": "total",
        "legendPosition": "bottom",
        "yAxisScaleType": "linear",
        "showAnnotations": true,
        "metricShowChange": true,
        "yAxisStartAtZero": true,
        "showMultipleYAxes": false,
        "showValuesOnSeries": false,
        "smoothingIntervals": 1,
        "showPercentStackView": false,
        "stackBreakdownValues": false,
        "aggregationAxisFormat": "duration_ms",
        "resultCustomizationBy": "value",
        "excludeBoxPlotOutliers": true,
        "metricColorByDirection": false,
        "showAlertThresholdLines": false
      },
      "filterTestAccounts": false
    }
  }
}
```

## 修改后

```json
{
  "id": 11927312,
  "name": "同步执行耗时 p95（不含排队）",
  "description": "production 的 execution_v2 终态事件：从本次成功取得运行权、写入 sync_started_at 起计至终态，不含计划排队及此前尝试。端到端总历时另存 end_to_end_duration_ms；原一小时分散调度保持不变。历史旧口径不参与此图；新数据自 2026-09-22 起。",
  "query": {
    "kind": "InsightVizNode",
    "source": {
      "kind": "TrendsQuery",
      "series": [
        {
          "kind": "EventsNode",
          "math": "p95",
          "name": "正式执行耗时（不含排队）",
          "event": "schedule_sync_completed",
          "properties": [
            {
              "key": "environment",
              "type": "event",
              "value": [
                "production"
              ],
              "operator": "exact"
            },
            {
              "key": "duration_basis",
              "type": "event",
              "value": [
                "execution_v2"
              ],
              "operator": "exact"
            }
          ],
          "math_property": "duration_ms"
        }
      ],
      "version": 4,
      "interval": "day",
      "dateRange": {
        "date_from": "-30d",
        "explicitDate": false,
        "excludeIncompletePeriods": false
      },
      "properties": [],
      "trendsFilter": {
        "display": "ActionsLineGraph",
        "showLegend": false,
        "hideWeekends": false,
        "metricSummary": "total",
        "legendPosition": "bottom",
        "yAxisScaleType": "linear",
        "showAnnotations": true,
        "metricShowChange": true,
        "yAxisStartAtZero": true,
        "showMultipleYAxes": false,
        "showValuesOnSeries": false,
        "smoothingIntervals": 1,
        "showPercentStackView": false,
        "stackBreakdownValues": false,
        "aggregationAxisFormat": "duration_ms",
        "resultCustomizationBy": "value",
        "excludeBoxPlotOutliers": true,
        "metricColorByDirection": false,
        "showAlertThresholdLines": false
      },
      "filterTestAccounts": false
    }
  }
}
```
