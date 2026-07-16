using TraceService from '../../srv/trace-service';

// ---------------------------------------------------------------------------
// Cold-chain condition monitoring — Fiori UI annotations
// ---------------------------------------------------------------------------

annotate TraceService.ConditionMonitors with @(
  UI: {
    HeaderInfo: {
      $Type         : 'UI.HeaderInfoType',
      TypeName      : 'Condition Monitor',
      TypeNamePlural: 'Condition Monitors',
      Title         : { $Type: 'UI.DataField', Value: batchIdHex },
      Description   : { $Type: 'UI.DataField', Value: status }
    },
    SelectionFields: [ status, breached, oracleVkh ],
    LineItem       : [
      { $Type: 'UI.DataField', Value: batchIdHex },
      { $Type: 'UI.DataField', Value: status,       Criticality: statusCriticality },
      { $Type: 'UI.DataField', Value: breached,     Criticality: breachCriticality },
      { $Type: 'UI.DataField', Value: readingCount },
      { $Type: 'UI.DataField', Value: breachCount,  Criticality: breachCriticality },
      { $Type: 'UI.DataField', Value: minMilliC },
      { $Type: 'UI.DataField', Value: maxMilliC }
    ],
    Facets         : [
      { $Type: 'UI.ReferenceFacet', ID: 'MonitorMain', Label: 'Monitor', Target: '@UI.FieldGroup#Main' },
      { $Type: 'UI.ReferenceFacet', ID: 'MonitorReadings', Label: 'Readings', Target: 'readings/@UI.LineItem' }
    ],
    FieldGroup #Main: {
      $Type: 'UI.FieldGroupType',
      Data : [
        { $Type: 'UI.DataField', Value: batchIdHex },
        { $Type: 'UI.DataField', Value: oracleVkh },
        { $Type: 'UI.DataField', Value: minMilliC },
        { $Type: 'UI.DataField', Value: maxMilliC },
        { $Type: 'UI.DataField', Value: readingCount },
        { $Type: 'UI.DataField', Value: breachCount,    Criticality: breachCriticality },
        { $Type: 'UI.DataField', Value: breached,       Criticality: breachCriticality },
        { $Type: 'UI.DataField', Value: status,         Criticality: statusCriticality },
        { $Type: 'UI.DataField', Value: commitRoot },
        { $Type: 'UI.DataField', Value: currentUtxoRef },
        { $Type: 'UI.DataField', Value: policyId },
        { $Type: 'UI.DataField', Value: scriptAddress }
      ]
    }
  }
) {
  ID             @Common.Label: 'Monitor ID';
  batchIdHex     @Common.Label: 'Batch ID (hex)';
  oracleVkh      @Common.Label: 'Oracle VKH';
  minMilliC      @Common.Label: 'Min (m°C)';
  maxMilliC      @Common.Label: 'Max (m°C)';
  readingCount   @Common.Label: 'Readings';
  breachCount    @Common.Label: 'Breaches';
  breached       @Common.Label: 'Breached';
  commitRoot     @Common.Label: 'Commit Root';
  currentUtxoRef @Common.Label: 'Current UTxO';
  status         @Common.Label: 'Status';
  policyId       @Common.Label: 'Policy ID';
  scriptAddress  @Common.Label: 'Script Address';
};

annotate TraceService.ConditionReadings with @(
  UI: {
    HeaderInfo: {
      $Type         : 'UI.HeaderInfoType',
      TypeName      : 'Sensor Reading',
      TypeNamePlural: 'Sensor Readings',
      Title         : { $Type: 'UI.DataField', Value: metric },
      Description   : { $Type: 'UI.DataField', Value: milliValue }
    },
    LineItem  : [
      { $Type: 'UI.DataField', Value: recordedAt },
      { $Type: 'UI.DataField', Value: metric },
      { $Type: 'UI.DataField', Value: milliValue,      Criticality: specCriticality },
      { $Type: 'UI.DataField', Value: withinSpec,      Criticality: specCriticality },
      { $Type: 'UI.DataField', Value: committedTxHash }
    ]
  }
) {
  metric          @Common.Label: 'Metric';
  milliValue      @Common.Label: 'Value (milli)';
  recordedAt      @Common.Label: 'Recorded At';
  withinSpec      @Common.Label: 'Within Spec';
  leafHash        @Common.Label: 'Leaf Hash';
  committedTxHash @Common.Label: 'Committed Tx';
};
