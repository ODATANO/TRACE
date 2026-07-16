/**
 * Unit tests for the cold_chain (condition-monitoring) builders in
 * srv/lib/chain-adapter.ts. These pin the Aiken/Pebble cold_chain ABI exactly:
 *   Mint:  InitMonitor=0   BurnMonitor=1
 *   Spend: RecordReadings=0 Close=1
 *   Datum: MonitorState=0 { oracle, batch_id, min, max, rc, bc, root, breached }
 * A regression here would produce an unspendable monitor thread.
 */

import {
  buildColdChainParams,
  buildMonitorStateDatum,
  buildInitMonitorRedeemer,
  buildBurnMonitorRedeemer,
  buildRecordReadingsRedeemer,
  buildCloseMonitorRedeemer,
  getValidatorHex,
  COLD_CHAIN_MINT_TITLE,
  COLD_CHAIN_SPEND_TITLE,
  MONITOR_ASSET_NAME_HEX,
} from '../../srv/lib/chain-adapter';
import { sha256Hex } from '../../srv/lib/digest';

const ORACLE = 'a'.repeat(56);
const SEED_TX = 'c'.repeat(64);
const SCRIPT_TX = 'd'.repeat(64);
const ROOT = '00'.repeat(32);

describe('buildColdChainParams', () => {
  it('produces [oracle VKH, seed OutputReference]', () => {
    const parsed = JSON.parse(buildColdChainParams(ORACLE, SEED_TX, 2));
    const expected: any = [
      { bytes: ORACLE },
      { constructor: 0, fields: [{ bytes: SEED_TX }, { int: 2 }] },
    ];
    expect(parsed).toEqual(expected);
  });
});

describe('buildMonitorStateDatum', () => {
  it('emits constructor=0 with the seven state fields in order (oracle is the script param)', () => {
    const parsed = JSON.parse(
      buildMonitorStateDatum('6261746368', 2000, 8000, 10, 1, ROOT, true)
    );
    expect(parsed).toEqual({
      constructor: 0,
      fields: [
        { bytes: '6261746368' },
        { int: 2000 },
        { int: 8000 },
        { int: 10 },
        { int: 1 },
        { bytes: ROOT },
        { int: 1 },
      ],
    });
  });

  it('encodes breached=false as int 0', () => {
    const parsed = JSON.parse(buildMonitorStateDatum('aa', -25000, 0, 0, 0, ROOT, false));
    expect(parsed.fields[6]).toEqual({ int: 0 });
  });

  it('supports negative spec bounds (freezer ranges)', () => {
    const parsed = JSON.parse(buildMonitorStateDatum('aa', -25000, -15000, 0, 0, ROOT, false));
    expect(parsed.fields[1]).toEqual({ int: -25000 });
    expect(parsed.fields[2]).toEqual({ int: -15000 });
  });
});

describe('cold-chain redeemer builders pin the ABI', () => {
  it('buildInitMonitorRedeemer → constructor=0', () => {
    expect(JSON.parse(buildInitMonitorRedeemer())).toEqual({ constructor: 0, fields: [] });
  });

  it('buildBurnMonitorRedeemer → constructor=1', () => {
    expect(JSON.parse(buildBurnMonitorRedeemer())).toEqual({ constructor: 1, fields: [] });
  });

  it('buildRecordReadingsRedeemer → constructor=0 with __INPUT_IDX__ + output 0', () => {
    const parsed = JSON.parse(buildRecordReadingsRedeemer(SCRIPT_TX, 1));
    expect(parsed.constructor).toBe(0);
    expect(parsed.fields[0].int).toBe(`__INPUT_IDX:${SCRIPT_TX}#1__`);
    expect(parsed.fields[1].int).toBe(0);
  });

  it('buildCloseMonitorRedeemer → constructor=1', () => {
    expect(JSON.parse(buildCloseMonitorRedeemer())).toEqual({ constructor: 1, fields: [] });
  });
});

describe('MONITOR_ASSET_NAME_HEX', () => {
  it('is the empty string (monitor thread token has empty name)', () => {
    expect(MONITOR_ASSET_NAME_HEX).toBe('');
  });
});

describe('getValidatorHex resolves the cold_chain validators', () => {
  it('returns CBOR-hex for the mint validator', () => {
    expect(getValidatorHex(COLD_CHAIN_MINT_TITLE)).toMatch(/^[0-9a-fA-F]+$/);
  });

  it('returns CBOR-hex for the spend validator', () => {
    expect(getValidatorHex(COLD_CHAIN_SPEND_TITLE)).toMatch(/^[0-9a-fA-F]+$/);
  });
});

describe('sha256Hex commit-root chaining', () => {
  it('is a 32-byte (64-hex) deterministic digest', () => {
    const h = sha256Hex('coldchain-genesis:batch:oracle:tx#0');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('coldchain-genesis:batch:oracle:tx#0')).toBe(h);
  });

  it('chains: new root depends on previous root and leaves', () => {
    const genesis = sha256Hex('g');
    const leafA = sha256Hex('a');
    const leafB = sha256Hex('b');
    const root1 = sha256Hex(genesis + leafA + leafB);
    const root2 = sha256Hex(root1 + leafA);
    expect(root1).not.toBe(genesis);
    expect(root2).not.toBe(root1);
    // order matters
    expect(sha256Hex(genesis + leafA + leafB)).not.toBe(sha256Hex(genesis + leafB + leafA));
  });
});
