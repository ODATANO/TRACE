use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address
use cardano/assets
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
} as tx_mod

// -- Datum: travels with UTxOs locked at the script address --

pub type ContractDatum {
  ChainOfCustody {
    manufacturer: VerificationKeyHash,
    current_holder: VerificationKeyHash,
    batch_id: ByteArray,
    step: Int,
  }
  MintCounter { n: Int }
}

// -- Mint redeemer --

pub type MintAction {
  InitCounter
  MintBatch { counter_input_idx: Int }
  Burn
}

// -- Spend redeemer --

pub type SpendAction {
  Transfer { input_idx: Int, output_idx: Int }
  Deliver
  IncrementCounter { own_input_idx: Int }
}

// Counter NFT always has the empty asset name
pub const counter_name: AssetName = #""

// Minimal big-endian encoding of a non-negative integer.
// MUST match the off-chain encoding used for batch token names
// (aligned with Pebble's `int as bytes`).
pub fn int_to_bytes(n: Int) -> ByteArray {
  if n == 0 {
    #""
  } else {
    int_to_bytes_loop(n, #"")
  }
}

fn int_to_bytes_loop(n: Int, acc: ByteArray) -> ByteArray {
  if n == 0 {
    acc
  } else {
    int_to_bytes_loop(n / 256, bytearray.push(acc, n % 256))
  }
}

// Extracts script hash from an address, fails if pubkey-owned.
fn script_hash_of(addr: address.Address) -> ByteArray {
  when addr.payment_credential is {
    address.Script(hash) -> hash
    _ -> fail
  }
}

fn is_at_script(addr: address.Address, hash: ByteArray) -> Bool {
  when addr.payment_credential is {
    address.Script(h) -> h == hash
    _ -> False
  }
}

// -- Mint logic --

pub fn can_init_counter(
  tx: Transaction,
  policy_id: PolicyId,
  seed: OutputReference,
) -> Bool {
  let seed_consumed =
    list.any(tx.inputs, fn(i) { i.output_reference == seed })

  let mint_ok =
    when tx.mint |> assets.tokens(policy_id) |> dict.to_pairs() is {
      [Pair(name, qty)] -> name == counter_name && qty == 1
      _ -> False
    }

  let outputs_ok =
    when tx.outputs is {
      [output] -> {
        let at_script = is_at_script(output.address, policy_id)
        let datum_ok =
          when output.datum is {
            InlineDatum(raw) -> {
              expect d: ContractDatum = raw
              when d is {
                MintCounter { n } -> n == 0
                _ -> False
              }
            }
            _ -> False
          }
        let token_ok =
          assets.quantity_of(output.value, policy_id, counter_name) == 1
        at_script && datum_ok && token_ok
      }
      _ -> False
    }

  seed_consumed && mint_ok && outputs_ok
}

// Delegates full validation to the counter-UTxO spend (IncrementCounter).
// Only verifies that the referenced input is the counter living at this policy.
pub fn can_mint_batch(
  tx: Transaction,
  policy_id: PolicyId,
  counter_input_idx: Int,
) -> Bool {
  when list.at(tx.inputs, counter_input_idx) is {
    Some(input) -> {
      let at_script = is_at_script(input.output.address, policy_id)
      let holds_counter =
        assets.quantity_of(input.output.value, policy_id, counter_name) == 1
      at_script && holds_counter
    }
    None -> False
  }
}

pub fn can_burn(tx: Transaction, policy_id: PolicyId) -> Bool {
  tx.mint
    |> assets.tokens(policy_id)
    |> dict.to_pairs()
    |> list.all(
        fn(pair) {
          let Pair(_, qty) = pair
          qty < 0
        },
      )
}

// -- Spend logic --

pub fn can_transfer(
  tx: Transaction,
  datum: ContractDatum,
  own_ref: OutputReference,
  input_idx: Int,
  output_idx: Int,
) -> Bool {
  expect ChainOfCustody {
    manufacturer: m,
    current_holder,
    batch_id,
    step,
  } = datum

  expect Some(own_input) = list.at(tx.inputs, input_idx)
  let ref_matches = own_input.output_reference == own_ref
  let own_hash = script_hash_of(own_input.output.address)

  let holder_signed = list.has(tx.extra_signatories, current_holder)

  expect Some(out) = list.at(tx.outputs, output_idx)

  let out_at_script = is_at_script(out.address, own_hash)

  let datum_ok =
    when out.datum is {
      InlineDatum(raw) -> {
        expect d: ContractDatum = raw
        when d is {
          ChainOfCustody {
            manufacturer: m2,
            current_holder: nh,
            batch_id: b2,
            step: s2,
          } ->
            m2 == m && bytearray.length(nh) == 28 && b2 == batch_id && s2 == step + 1
          _ -> False
        }
      }
      _ -> False
    }

  let nft_preserved =
    assets.quantity_of(out.value, own_hash, batch_id) == 1

  ref_matches && holder_signed && out_at_script && datum_ok && nft_preserved
}

pub fn can_deliver(tx: Transaction, datum: ContractDatum) -> Bool {
  expect ChainOfCustody { current_holder, .. } = datum
  list.has(tx.extra_signatories, current_holder)
}

// The real mint validation for new batches lives here. One TX spends the
// counter-UTxO (this function) + mints k batch NFTs (mintBatch endpoint).
// Output[0] = updated counter. Output[1..k] = batch NFTs, each with
// ChainOfCustody { manufacturer, current_holder = manufacturer, batch_id, step=0 }.
pub fn can_increment_counter(
  tx: Transaction,
  datum: ContractDatum,
  own_ref: OutputReference,
  own_input_idx: Int,
  manufacturer: VerificationKeyHash,
) -> Bool {
  expect MintCounter { n: prev_counter } = datum

  let sig_ok = list.has(tx.extra_signatories, manufacturer)

  expect Some(own_input) = list.at(tx.inputs, own_input_idx)
  let ref_matches = own_input.output_reference == own_ref
  let own_hash = script_hash_of(own_input.output.address)

  let counter_in_place =
    assets.quantity_of(own_input.output.value, own_hash, counter_name) == 1

  let mints =
    tx.mint |> assets.tokens(own_hash) |> dict.to_pairs()

  let batch_outputs = list.drop(tx.outputs, 1)

  let (final_counter, batches_ok) =
    validate_batches(mints, batch_outputs, own_hash, manufacturer, prev_counter)

  expect Some(counter_out) = list.at(tx.outputs, 0)
  let counter_at_script = is_at_script(counter_out.address, own_hash)
  let counter_token_ok =
    assets.quantity_of(counter_out.value, own_hash, counter_name) == 1
  let counter_datum_ok =
    when counter_out.datum is {
      InlineDatum(raw) -> {
        expect d: ContractDatum = raw
        when d is {
          MintCounter { n } -> n == final_counter
          _ -> False
        }
      }
      _ -> False
    }

  sig_ok && ref_matches && counter_in_place && batches_ok && counter_at_script && counter_token_ok && counter_datum_ok
}

fn validate_batches(
  mints: List<Pair<ByteArray, Int>>,
  outputs: List<Output>,
  policy: PolicyId,
  manufacturer: VerificationKeyHash,
  counter: Int,
) -> (Int, Bool) {
  when mints is {
    [] -> (counter, True)
    [Pair(name, qty), ..rest] -> {
      let next = counter + 1
      let expected = int_to_bytes(next)
      let name_ok = name == expected
      let qty_ok = qty == 1
      when outputs is {
        [] -> (next, False)
        [out, ..rest_outs] -> {
          let out_at_script = is_at_script(out.address, policy)
          let nft_ok =
            assets.quantity_of(out.value, policy, name) == 1
          let datum_ok =
            when out.datum is {
              InlineDatum(raw) -> {
                expect d: ContractDatum = raw
                when d is {
                  ChainOfCustody {
                    manufacturer: m,
                    current_holder: ch,
                    batch_id: b,
                    step: s,
                  } ->
                    m == manufacturer && ch == manufacturer && b == name && s == 0
                  _ -> False
                }
              }
              _ -> False
            }
          if name_ok && qty_ok && out_at_script && nft_ok && datum_ok {
            validate_batches(rest, rest_outs, policy, manufacturer, next)
          } else {
            (next, False)
          }
        }
      }
    }
  }
}

// -- Validator --

validator pharma_trace(
  manufacturer: VerificationKeyHash,
  seed: OutputReference,
) {
  mint(redeemer: MintAction, policy_id: PolicyId, self: Transaction) {
    when redeemer is {
      InitCounter -> can_init_counter(self, policy_id, seed)
      MintBatch { counter_input_idx } ->
        can_mint_batch(self, policy_id, counter_input_idx)
      Burn -> can_burn(self, policy_id)
    }
  }

  spend(
    datum: Option<ContractDatum>,
    redeemer: SpendAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      Transfer { input_idx, output_idx } ->
        can_transfer(self, d, own_ref, input_idx, output_idx)
      Deliver -> can_deliver(self, d)
      IncrementCounter { own_input_idx } ->
        can_increment_counter(self, d, own_ref, own_input_idx, manufacturer)
    }
  }

  else(_) {
    fail
  }
}

// -- Test fixtures --

const mfr_vkh: VerificationKeyHash =
  #"11111111111111111111111111111111111111111111111111111111"

const holder_b_vkh: VerificationKeyHash =
  #"22222222222222222222222222222222222222222222222222222222"

const policy_id: PolicyId =
  #"33333333333333333333333333333333333333333333333333333333"

const seed_ref: OutputReference =
  OutputReference {
    transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
    output_index: 0,
  }

const batch_ref: OutputReference =
  OutputReference {
    transaction_id: #"5555555555555555555555555555555555555555555555555555555555555555",
    output_index: 0,
  }

const counter_ref: OutputReference =
  OutputReference {
    transaction_id: #"6666666666666666666666666666666666666666666666666666666666666666",
    output_index: 0,
  }

fn script_addr() -> address.Address {
  address.from_script(policy_id)
}

fn wallet_input(ref: OutputReference) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: address.from_verification_key(mfr_vkh),
      value: assets.from_lovelace(5_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn counter_utxo(ref: OutputReference, n: Int) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: script_addr(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(policy_id, counter_name, 1),
      datum: InlineDatum(MintCounter { n }),
      reference_script: None,
    },
  }
}

fn counter_output(n: Int) -> Output {
  Output {
    address: script_addr(),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(policy_id, counter_name, 1),
    datum: InlineDatum(MintCounter { n }),
    reference_script: None,
  }
}

fn batch_output(batch_name: ByteArray) -> Output {
  Output {
    address: script_addr(),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(policy_id, batch_name, 1),
    datum: InlineDatum(
      ChainOfCustody {
        manufacturer: mfr_vkh,
        current_holder: mfr_vkh,
        batch_id: batch_name,
        step: 0,
      },
    ),
    reference_script: None,
  }
}

fn batch_utxo(holder: VerificationKeyHash, step: Int, name: ByteArray) -> Input {
  Input {
    output_reference: batch_ref,
    output: Output {
      address: script_addr(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(policy_id, name, 1),
      datum: InlineDatum(
        ChainOfCustody {
          manufacturer: mfr_vkh,
          current_holder: holder,
          batch_id: name,
          step,
        },
      ),
      reference_script: None,
    },
  }
}

fn transfer_output(next_holder: VerificationKeyHash, step: Int, name: ByteArray) -> Output {
  Output {
    address: script_addr(),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(policy_id, name, 1),
    datum: InlineDatum(
      ChainOfCustody {
        manufacturer: mfr_vkh,
        current_holder: next_holder,
        batch_id: name,
        step,
      },
    ),
    reference_script: None,
  }
}

// -- int_to_bytes unit tests --

test int_to_bytes_zero() {
  int_to_bytes(0) == #""
}

test int_to_bytes_one() {
  int_to_bytes(1) == #"01"
}

test int_to_bytes_256() {
  int_to_bytes(256) == #"0100"
}

test int_to_bytes_258() {
  int_to_bytes(258) == #"0102"
}

// -- init_counter tests --

test init_counter_accepts_valid_tx() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [counter_output(0)],
      mint: assets.from_asset(policy_id, counter_name, 1),
      extra_signatories: [mfr_vkh],
    }
  can_init_counter(tx, policy_id, seed_ref) == True
}

test init_counter_rejects_without_seed() {
  let other =
    OutputReference {
      transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      output_index: 0,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(other)],
      outputs: [counter_output(0)],
      mint: assets.from_asset(policy_id, counter_name, 1),
    }
  can_init_counter(tx, policy_id, seed_ref) == False
}

test init_counter_rejects_wrong_token_name() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [counter_output(0)],
      mint: assets.from_asset(policy_id, #"deadbeef", 1),
    }
  can_init_counter(tx, policy_id, seed_ref) == False
}

test init_counter_rejects_wrong_qty() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [counter_output(0)],
      mint: assets.from_asset(policy_id, counter_name, 2),
    }
  can_init_counter(tx, policy_id, seed_ref) == False
}

test init_counter_rejects_nonzero_start_value() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [counter_output(1)],
      mint: assets.from_asset(policy_id, counter_name, 1),
    }
  can_init_counter(tx, policy_id, seed_ref) == False
}

// -- mint_batch tests (gate only — real work is in increment_counter) --

test mint_batch_accepts_with_valid_counter_input() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [counter_utxo(counter_ref, 0)],
    }
  can_mint_batch(tx, policy_id, 0) == True
}

test mint_batch_rejects_when_input_is_wallet() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
    }
  can_mint_batch(tx, policy_id, 0) == False
}

test mint_batch_rejects_out_of_bounds_index() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [counter_utxo(counter_ref, 0)],
    }
  can_mint_batch(tx, policy_id, 5) == False
}

// -- burn tests --

test burn_accepts_when_all_negative() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      mint: assets.from_asset(policy_id, #"01", -1),
    }
  can_burn(tx, policy_id) == True
}

test burn_rejects_positive_qty() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      mint: assets.from_asset(policy_id, #"01", 1),
    }
  can_burn(tx, policy_id) == False
}

// -- transfer tests --

test transfer_accepts_valid_flow() {
  let datum =
    ChainOfCustody {
      manufacturer: mfr_vkh,
      current_holder: mfr_vkh,
      batch_id: #"01",
      step: 0,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [batch_utxo(mfr_vkh, 0, #"01")],
      outputs: [transfer_output(holder_b_vkh, 1, #"01")],
      extra_signatories: [mfr_vkh],
    }
  can_transfer(tx, datum, batch_ref, 0, 0) == True
}

test transfer_rejects_without_holder_sig() {
  let datum =
    ChainOfCustody {
      manufacturer: mfr_vkh,
      current_holder: mfr_vkh,
      batch_id: #"01",
      step: 0,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [batch_utxo(mfr_vkh, 0, #"01")],
      outputs: [transfer_output(holder_b_vkh, 1, #"01")],
      extra_signatories: [],
    }
  can_transfer(tx, datum, batch_ref, 0, 0) == False
}

test transfer_rejects_step_not_incremented() {
  let datum =
    ChainOfCustody {
      manufacturer: mfr_vkh,
      current_holder: mfr_vkh,
      batch_id: #"01",
      step: 0,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [batch_utxo(mfr_vkh, 0, #"01")],
      outputs: [transfer_output(holder_b_vkh, 0, #"01")],
      extra_signatories: [mfr_vkh],
    }
  can_transfer(tx, datum, batch_ref, 0, 0) == False
}

test transfer_rejects_batch_id_changed() {
  let datum =
    ChainOfCustody {
      manufacturer: mfr_vkh,
      current_holder: mfr_vkh,
      batch_id: #"01",
      step: 0,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [batch_utxo(mfr_vkh, 0, #"01")],
      outputs: [transfer_output(holder_b_vkh, 1, #"02")],
      extra_signatories: [mfr_vkh],
    }
  can_transfer(tx, datum, batch_ref, 0, 0) == False
}

test transfer_rejects_invalid_next_holder_length() {
  let datum =
    ChainOfCustody {
      manufacturer: mfr_vkh,
      current_holder: mfr_vkh,
      batch_id: #"01",
      step: 0,
    }
  let short_holder: ByteArray = #"aabbcc"
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [batch_utxo(mfr_vkh, 0, #"01")],
      outputs: [transfer_output(short_holder, 1, #"01")],
      extra_signatories: [mfr_vkh],
    }
  can_transfer(tx, datum, batch_ref, 0, 0) == False
}

// -- deliver tests --

test deliver_accepts_with_holder_sig() {
  let datum =
    ChainOfCustody {
      manufacturer: mfr_vkh,
      current_holder: mfr_vkh,
      batch_id: #"01",
      step: 3,
    }
  let tx =
    Transaction { ..tx_mod.placeholder, extra_signatories: [mfr_vkh] }
  can_deliver(tx, datum) == True
}

test deliver_rejects_without_holder_sig() {
  let datum =
    ChainOfCustody {
      manufacturer: mfr_vkh,
      current_holder: mfr_vkh,
      batch_id: #"01",
      step: 3,
    }
  let tx = Transaction { ..tx_mod.placeholder, extra_signatories: [] }
  can_deliver(tx, datum) == False
}

// -- increment_counter tests --

test increment_counter_accepts_single_batch() {
  let datum = MintCounter { n: 0 }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [counter_utxo(counter_ref, 0)],
      outputs: [counter_output(1), batch_output(#"01")],
      mint: assets.from_asset(policy_id, #"01", 1),
      extra_signatories: [mfr_vkh],
    }
  can_increment_counter(tx, datum, counter_ref, 0, mfr_vkh) == True
}

test increment_counter_accepts_multiple_batches() {
  let datum = MintCounter { n: 0 }
  let mint_value =
    assets.from_asset(policy_id, #"01", 1)
      |> assets.add(policy_id, #"02", 1)
      |> assets.add(policy_id, #"03", 1)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [counter_utxo(counter_ref, 0)],
      outputs: [
        counter_output(3),
        batch_output(#"01"),
        batch_output(#"02"),
        batch_output(#"03"),
      ],
      mint: mint_value,
      extra_signatories: [mfr_vkh],
    }
  can_increment_counter(tx, datum, counter_ref, 0, mfr_vkh) == True
}

test increment_counter_rejects_without_manufacturer_sig() {
  let datum = MintCounter { n: 0 }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [counter_utxo(counter_ref, 0)],
      outputs: [counter_output(1), batch_output(#"01")],
      mint: assets.from_asset(policy_id, #"01", 1),
      extra_signatories: [],
    }
  can_increment_counter(tx, datum, counter_ref, 0, mfr_vkh) == False
}

test increment_counter_rejects_skipped_number() {
  let datum = MintCounter { n: 0 }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [counter_utxo(counter_ref, 0)],
      outputs: [counter_output(1), batch_output(#"02")],
      mint: assets.from_asset(policy_id, #"02", 1),
      extra_signatories: [mfr_vkh],
    }
  can_increment_counter(tx, datum, counter_ref, 0, mfr_vkh) == False
}

test increment_counter_rejects_wrong_new_counter_value() {
  let datum = MintCounter { n: 0 }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [counter_utxo(counter_ref, 0)],
      outputs: [counter_output(2), batch_output(#"01")],
      mint: assets.from_asset(policy_id, #"01", 1),
      extra_signatories: [mfr_vkh],
    }
  can_increment_counter(tx, datum, counter_ref, 0, mfr_vkh) == False
}

test increment_counter_rejects_batch_with_wrong_holder() {
  let datum = MintCounter { n: 0 }
  let bad_batch =
    Output {
      address: script_addr(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(policy_id, #"01", 1),
      datum: InlineDatum(
        ChainOfCustody {
          manufacturer: mfr_vkh,
          current_holder: holder_b_vkh,
          batch_id: #"01",
          step: 0,
        },
      ),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [counter_utxo(counter_ref, 0)],
      outputs: [counter_output(1), bad_batch],
      mint: assets.from_asset(policy_id, #"01", 1),
      extra_signatories: [mfr_vkh],
    }
  can_increment_counter(tx, datum, counter_ref, 0, mfr_vkh) == False
}
