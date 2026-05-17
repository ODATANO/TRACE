/**
 * Unit tests for the pure datum/redeemer/script-param builders exported from
 * srv/lib/chain-adapter.ts. These mirror the Aiken validator ABI exactly —
 * a regression here would produce unspendable assets, so the tests pin the
 * constructor indices, field tags, and integer encodings.
 *
 * No mocks: every function here is deterministic and side-effect free, except
 * for getValidatorHex which reads the committed contracts/plutus.json.
 */

import {
  buildBurnRedeemer,
  buildChainOfCustodyDatum,
  buildDeliverRedeemer,
  buildIncrementCounterRedeemer,
  buildInitCounterRedeemer,
  buildMintBatchRedeemer,
  buildMintCounterDatum,
  buildScriptParams,
  buildTransferRedeemer,
  COUNTER_ASSET_NAME_HEX,
  getValidatorHex,
  intToBytes,
  toHex,
} from '../../srv/lib/chain-adapter';

const VKH = 'a'.repeat(56);
const VKH2 = 'b'.repeat(56);
const TX_HASH = 'c'.repeat(64);

describe('intToBytes', () => {
  it('returns empty string for 0 (Aiken int_to_bytes convention)', () => {
    expect(intToBytes(0)).toBe('');
  });

  it('encodes single-byte values', () => {
    expect(intToBytes(1)).toBe('01');
    expect(intToBytes(15)).toBe('0f');
    expect(intToBytes(255)).toBe('ff');
  });

  it('encodes two-byte big-endian values', () => {
    expect(intToBytes(256)).toBe('0100');
    expect(intToBytes(65535)).toBe('ffff');
  });

  it('encodes three-byte values', () => {
    expect(intToBytes(65536)).toBe('010000');
    expect(intToBytes(0xabcdef)).toBe('abcdef');
  });

  it('produces minimal big-endian encoding (no leading zeros)', () => {
    expect(intToBytes(1)).not.toMatch(/^00/);
    expect(intToBytes(256)).not.toMatch(/^00/);
  });

  it('throws on negative integers', () => {
    expect(() => intToBytes(-1)).toThrow(/non-negative/);
  });

  it('throws on non-integer floats', () => {
    expect(() => intToBytes(1.5)).toThrow(/non-negative integer/);
  });

  it('throws on NaN', () => {
    expect(() => intToBytes(NaN)).toThrow();
  });
});

describe('toHex', () => {
  it('encodes ASCII strings to hex', () => {
    expect(toHex('A')).toBe('41');
    expect(toHex('REGISTRATION')).toBe('524547495354524154494f4e');
  });

  it('encodes multi-byte UTF-8 correctly', () => {
    expect(toHex('ä')).toBe('c3a4');
    expect(toHex('€')).toBe('e282ac');
  });

  it('returns empty string for empty input', () => {
    expect(toHex('')).toBe('');
  });
});

describe('buildChainOfCustodyDatum', () => {
  it('produces constructor=0 with the expected four fields in order', () => {
    const json = buildChainOfCustodyDatum(VKH, VKH2, '6d795f62617463685f3031', 3);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      constructor: 0,
      fields: [
        { bytes: VKH },
        { bytes: VKH2 },
        { bytes: '6d795f62617463685f3031' },
        { int: 3 },
      ],
    });
  });

  it('emits valid JSON', () => {
    expect(() => JSON.parse(buildChainOfCustodyDatum(VKH, VKH2, 'aa', 0))).not.toThrow();
  });
});

describe('buildTransferRedeemer', () => {
  it('embeds the __INPUT_IDX__ placeholder at fields[0].int', () => {
    const json = buildTransferRedeemer(TX_HASH, 2);
    const parsed = JSON.parse(json);
    expect(parsed.constructor).toBe(0);
    expect(parsed.fields[0].int).toBe(`__INPUT_IDX:${TX_HASH}#2__`);
  });

  it('pins fields[1].int to 0 (continuing output position)', () => {
    const json = buildTransferRedeemer(TX_HASH, 0);
    expect(JSON.parse(json).fields[1].int).toBe(0);
  });

  it('placeholder matches ODATANO INPUT_IDX contract (lowercase 64-hex + index)', () => {
    const json = buildTransferRedeemer(TX_HASH, 7);
    expect(json).toMatch(/__INPUT_IDX:[0-9a-f]{64}#\d+__/);
  });
});

describe('buildDeliverRedeemer', () => {
  it('emits constructor=1 with empty fields', () => {
    expect(JSON.parse(buildDeliverRedeemer())).toEqual({ constructor: 1, fields: [] });
  });
});

describe('buildMintCounterDatum', () => {
  it('emits constructor=1 with vkh bytes + int count', () => {
    const parsed = JSON.parse(buildMintCounterDatum(VKH, 42));
    expect(parsed).toEqual({
      constructor: 1,
      fields: [{ bytes: VKH }, { int: 42 }],
    });
  });

  it('accepts zero as the initial counter value', () => {
    const parsed = JSON.parse(buildMintCounterDatum(VKH, 0));
    expect(parsed.fields[1]).toEqual({ int: 0 });
  });
});

describe('mint-redeemer builders pin the Aiken ABI', () => {
  it('buildInitCounterRedeemer → constructor=0', () => {
    expect(JSON.parse(buildInitCounterRedeemer())).toEqual({ constructor: 0, fields: [] });
  });

  it('buildMintBatchRedeemer → constructor=1 with counter input index', () => {
    expect(JSON.parse(buildMintBatchRedeemer(5))).toEqual({
      constructor: 1,
      fields: [{ int: 5 }],
    });
  });

  it('buildBurnRedeemer → constructor=2', () => {
    expect(JSON.parse(buildBurnRedeemer())).toEqual({ constructor: 2, fields: [] });
  });

  it('buildIncrementCounterRedeemer → constructor=2 with own input index', () => {
    expect(JSON.parse(buildIncrementCounterRedeemer(3))).toEqual({
      constructor: 2,
      fields: [{ int: 3 }],
    });
  });
});

describe('buildScriptParams', () => {
  it('produces [vkh, OutputReference] in exact validator-expected shape', () => {
    const parsed = JSON.parse(buildScriptParams(VKH, TX_HASH, 1));
    const expected: any = [
      { bytes: VKH },
      { constructor: 0, fields: [{ bytes: TX_HASH }, { int: 1 }] },
    ];
    expect(parsed).toEqual(expected);
  });
});

describe('COUNTER_ASSET_NAME_HEX', () => {
  it('is the empty string (Aiken int_to_bytes(0) convention)', () => {
    expect(COUNTER_ASSET_NAME_HEX).toBe('');
    expect(COUNTER_ASSET_NAME_HEX).toBe(intToBytes(0));
  });
});

describe('getValidatorHex', () => {
  it('returns a non-empty CBOR-hex string for a known validator title', () => {
    const hex = getValidatorHex('pharma_trace.pharma_trace.mint');
    expect(hex).toMatch(/^[0-9a-fA-F]+$/);
    expect(hex.length).toBeGreaterThan(0);
  });

  it('throws with a precise message when the title is unknown', () => {
    expect(() => getValidatorHex('nonexistent.validator')).toThrow(
      /Validator "nonexistent\.validator" not found/
    );
  });

  it('returns the spend validator under the expected title', () => {
    expect(() => getValidatorHex('pharma_trace.pharma_trace.spend')).not.toThrow();
  });
});
