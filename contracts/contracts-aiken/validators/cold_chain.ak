// -----------------------------------------------------------------------------
// TRACE Cold-Chain Condition-Monitoring Validator
//
// Companion to `pharma_trace` -- does NOT touch the batch-custody validator.
// Manages one monitoring "thread" NFT per batch (or per shipment leg) that
// accumulates tamper-evident sensor attestations as the goods move.
//
// Design: commit-on-chain / prove-off-chain. Individual temperature/humidity
// readings live off-chain; on-chain we keep a running commitment (`commit_root`,
// a 32-byte Merkle/hash root the oracle re-commits each batch) plus monotonic
// counters. The validator enforces the *integrity* properties that make the log
// trustworthy without paying for one tx per reading:
//   1. only the authorised oracle may append readings (signature)
//   2. reading_count is strictly monotonic   -> no silent dropping of readings
//   3. breach_count is monotonic             -> excursions cannot be un-counted
//   4. breached latches 0 -> 1, never back   -> an excursion can never be hidden
//   5. oracle / batch_id / spec-range are immutable for the monitor lifetime
//   6. the thread NFT is preserved at the script -> history cannot be forked
//
// -----------------------------------------------------------------------------
// Canonical ABI -- both Aiken and Pebble MUST match these indices.
// Mint:  InitMonitor=0   BurnMonitor=1
// Spend: RecordReadings=0 Close=1
// Datum: MonitorState=0
// Offchain (srv/lib/chain-adapter.ts) emits Constr values by this table.
// Do NOT reorder variants/methods without updating BOTH files + the offchain.
// -----------------------------------------------------------------------------

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

// -- Datum: travels with the monitoring UTxO locked at the script address --

pub type MonitorDatum {
  MonitorState {
    // Oracle identity is the validator parameter (bound via the parameterized
    // script hash); the datum stores only monitor state.
    batch_id: ByteArray,
    // Allowed spec range, signed integer milli-degrees Celsius
    // (fridge 2..8 C -> 2000..8000; freezer -25 C -> -25000).
    min_milli_c: Int,
    max_milli_c: Int,
    // Number of individual readings committed so far (strictly monotonic).
    reading_count: Int,
    // Number of out-of-spec readings observed so far (monotonic).
    breach_count: Int,
    // 32-byte running commitment to the off-chain reading log.
    commit_root: ByteArray,
    // 0 = within spec for whole journey, 1 = at least one excursion (latched).
    breached: Int,
  }
}

// -- Mint redeemer --

pub type MintAction {
  InitMonitor
  BurnMonitor
}

// -- Spend redeemer --

pub type SpendAction {
  RecordReadings { input_idx: Int, output_idx: Int }
  Close
}

// Monitor thread NFT always has the empty asset name.
pub const monitor_name: AssetName = #""

// Length of the off-chain log commitment, in bytes (blake2b-256 / Merkle root).
pub const root_len: Int = 32

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

// Bootstrap a monitor thread. Mirrors pharma_trace's can_init_counter:
// consume the one-shot seed (-> unique policy id), mint exactly one empty-named
// token, and lock it at the script with a zeroed MonitorState as output[0].
// The oracle field is not cross-checked here -- security is anchored in seed
// control (only the seed's owner can produce this transaction).
pub fn can_init_monitor(
  tx: Transaction,
  policy_id: PolicyId,
  seed: OutputReference,
) -> Bool {
  let seed_consumed =
    list.any(tx.inputs, fn(i) { i.output_reference == seed })

  let mint_ok =
    when tx.mint |> assets.tokens(policy_id) |> dict.to_pairs() is {
      [Pair(name, qty)] -> name == monitor_name && qty == 1
      _ -> False
    }

  expect Some(monitor_out) = list.at(tx.outputs, 0)
  let at_script = is_at_script(monitor_out.address, policy_id)
  let token_ok =
    assets.quantity_of(monitor_out.value, policy_id, monitor_name) == 1
  let datum_ok =
    when monitor_out.datum is {
      InlineDatum(raw) -> {
        expect d: MonitorDatum = raw
        let MonitorState {
          min_milli_c,
          max_milli_c,
          reading_count,
          breach_count,
          commit_root,
          breached,
          ..
        } = d
        reading_count == 0 && breach_count == 0 && breached == 0 && min_milli_c <= max_milli_c && bytearray.length(
          commit_root,
        ) == root_len
      }
      _ -> False
    }

  seed_consumed && mint_ok && at_script && token_ok && datum_ok
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

// Append a batch of off-chain readings to the monitor thread.
pub fn can_record_readings(
  tx: Transaction,
  datum: MonitorDatum,
  own_ref: OutputReference,
  input_idx: Int,
  output_idx: Int,
  oracle: VerificationKeyHash,
) -> Bool {
  let MonitorState {
    batch_id,
    min_milli_c,
    max_milli_c,
    reading_count,
    breach_count,
    commit_root: _old_root,
    breached,
  } = datum

  expect Some(own_input) = list.at(tx.inputs, input_idx)
  let ref_matches = own_input.output_reference == own_ref
  let own_hash = script_hash_of(own_input.output.address)

  let oracle_signed = list.has(tx.extra_signatories, oracle)

  expect Some(out) = list.at(tx.outputs, output_idx)
  let out_at_script = is_at_script(out.address, own_hash)
  let nft_preserved =
    assets.quantity_of(out.value, own_hash, monitor_name) == 1

  let datum_ok =
    when out.datum is {
      InlineDatum(raw) -> {
        expect d: MonitorDatum = raw
        let MonitorState {
          batch_id: b2,
          min_milli_c: lo2,
          max_milli_c: hi2,
          reading_count: rc2,
          breach_count: bc2,
          commit_root: root2,
          breached: br2,
        } = d
        let immutable_ok =
          b2 == batch_id && lo2 == min_milli_c && hi2 == max_milli_c
        let count_ok = rc2 > reading_count
        let breach_monotonic = bc2 >= breach_count
        let root_ok = bytearray.length(root2) == root_len
        // Latch: once breached stays breached; any new breach sets the flag.
        let expected_breached =
          if breached == 1 || bc2 > breach_count {
            1
          } else {
            0
          }
        let latch_ok = br2 == expected_breached
        immutable_ok && count_ok && breach_monotonic && root_ok && latch_ok
      }
      _ -> False
    }

  ref_matches && oracle_signed && out_at_script && nft_preserved && datum_ok
}

// Finalise the monitor (e.g. at delivery). Oracle signs; the thread NFT may
// then leave the script / be burned. No continuing-output constraints.
pub fn can_close(tx: Transaction, oracle: VerificationKeyHash) -> Bool {
  list.has(tx.extra_signatories, oracle)
}

// -- Validator --

validator cold_chain(oracle: VerificationKeyHash, seed: OutputReference) {
  mint(redeemer: MintAction, policy_id: PolicyId, self: Transaction) {
    when redeemer is {
      InitMonitor -> can_init_monitor(self, policy_id, seed)
      BurnMonitor -> can_burn(self, policy_id)
    }
  }

  spend(
    datum: Option<MonitorDatum>,
    redeemer: SpendAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      RecordReadings { input_idx, output_idx } ->
        can_record_readings(self, d, own_ref, input_idx, output_idx, oracle)
      Close -> can_close(self, oracle)
    }
  }

  else(_) {
    fail
  }
}

// -- Test fixtures --

const oracle_vkh: VerificationKeyHash =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const other_vkh: VerificationKeyHash =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const policy_id: PolicyId =
  #"33333333333333333333333333333333333333333333333333333333"

const root0: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000000"

const root1: ByteArray =
  #"1111111111111111111111111111111111111111111111111111111111111111"

const short_root: ByteArray = #"deadbeef"

const seed_ref: OutputReference =
  OutputReference {
    transaction_id: #"4444444444444444444444444444444444444444444444444444444444444444",
    output_index: 0,
  }

const monitor_ref: OutputReference =
  OutputReference {
    transaction_id: #"5555555555555555555555555555555555555555555555555555555555555555",
    output_index: 0,
  }

fn script_addr() -> address.Address {
  address.from_script(policy_id)
}

fn wallet_input(ref: OutputReference) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: address.from_verification_key(oracle_vkh),
      value: assets.from_lovelace(5_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// Standard fridge spec 2..8 C (milli-degrees).
fn mk_state(rc: Int, bc: Int, root: ByteArray, breached: Int) -> MonitorDatum {
  MonitorState {
    batch_id: #"01",
    min_milli_c: 2000,
    max_milli_c: 8000,
    reading_count: rc,
    breach_count: bc,
    commit_root: root,
    breached,
  }
}

fn state_output(state: MonitorDatum) -> Output {
  Output {
    address: script_addr(),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(policy_id, monitor_name, 1),
    datum: InlineDatum(state),
    reference_script: None,
  }
}

fn monitor_utxo(ref: OutputReference, state: MonitorDatum) -> Input {
  Input { output_reference: ref, output: state_output(state) }
}

// -- init_monitor tests --

test init_monitor_accepts_valid() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [state_output(mk_state(0, 0, root0, 0))],
      mint: assets.from_asset(policy_id, monitor_name, 1),
      extra_signatories: [oracle_vkh],
    }
  can_init_monitor(tx, policy_id, seed_ref) == True
}

test init_monitor_accepts_with_change_output() {
  let change =
    Output {
      address: address.from_verification_key(oracle_vkh),
      value: assets.from_lovelace(2_500_000),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [state_output(mk_state(0, 0, root0, 0)), change],
      mint: assets.from_asset(policy_id, monitor_name, 1),
    }
  can_init_monitor(tx, policy_id, seed_ref) == True
}

test init_monitor_rejects_without_seed() {
  let other =
    OutputReference {
      transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      output_index: 0,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(other)],
      outputs: [state_output(mk_state(0, 0, root0, 0))],
      mint: assets.from_asset(policy_id, monitor_name, 1),
    }
  can_init_monitor(tx, policy_id, seed_ref) == False
}

test init_monitor_rejects_wrong_qty() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [state_output(mk_state(0, 0, root0, 0))],
      mint: assets.from_asset(policy_id, monitor_name, 2),
    }
  can_init_monitor(tx, policy_id, seed_ref) == False
}

test init_monitor_rejects_nonzero_count() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [state_output(mk_state(5, 0, root0, 0))],
      mint: assets.from_asset(policy_id, monitor_name, 1),
    }
  can_init_monitor(tx, policy_id, seed_ref) == False
}

test init_monitor_rejects_prebreached() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [state_output(mk_state(0, 0, root0, 1))],
      mint: assets.from_asset(policy_id, monitor_name, 1),
    }
  can_init_monitor(tx, policy_id, seed_ref) == False
}

test init_monitor_rejects_bad_root_length() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [state_output(mk_state(0, 0, short_root, 0))],
      mint: assets.from_asset(policy_id, monitor_name, 1),
    }
  can_init_monitor(tx, policy_id, seed_ref) == False
}

test init_monitor_rejects_inverted_spec() {
  let bad =
    MonitorState {
      batch_id: #"01",
      min_milli_c: 8000,
      max_milli_c: 2000,
      reading_count: 0,
      breach_count: 0,
      commit_root: root0,
      breached: 0,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [wallet_input(seed_ref)],
      outputs: [state_output(bad)],
      mint: assets.from_asset(policy_id, monitor_name, 1),
    }
  can_init_monitor(tx, policy_id, seed_ref) == False
}

// -- record_readings tests --

test record_accepts_clean_batch() {
  let datum = mk_state(10, 0, root0, 0)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mk_state(20, 0, root1, 0))],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == True
}

test record_accepts_breach_latches() {
  let datum = mk_state(10, 0, root0, 0)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mk_state(20, 3, root1, 1))],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == True
}

test record_accepts_when_already_breached() {
  let datum = mk_state(20, 3, root0, 1)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mk_state(30, 3, root1, 1))],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == True
}

test record_rejects_without_oracle_sig() {
  let datum = mk_state(10, 0, root0, 0)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mk_state(20, 0, root1, 0))],
      extra_signatories: [other_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

test record_rejects_count_not_increased() {
  let datum = mk_state(10, 0, root0, 0)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mk_state(10, 0, root1, 0))],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

test record_rejects_breach_count_decreased() {
  let datum = mk_state(10, 2, root0, 1)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mk_state(20, 1, root1, 1))],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

test record_rejects_unlatch_breach() {
  // was breached, new datum clears the flag -- must be rejected.
  let datum = mk_state(20, 3, root0, 1)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mk_state(30, 3, root1, 0))],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

test record_rejects_breach_flag_not_set() {
  // breach_count increased but breached flag left at 0 -- must be rejected.
  let datum = mk_state(10, 0, root0, 0)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mk_state(20, 2, root1, 0))],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

test record_rejects_batch_id_changed() {
  let datum = mk_state(10, 0, root0, 0)
  let mutated =
    MonitorState {
      batch_id: #"02",
      min_milli_c: 2000,
      max_milli_c: 8000,
      reading_count: 20,
      breach_count: 0,
      commit_root: root1,
      breached: 0,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mutated)],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

test record_rejects_spec_changed() {
  let datum = mk_state(10, 0, root0, 0)
  let mutated =
    MonitorState {
      batch_id: #"01",
      min_milli_c: 0,
      max_milli_c: 30000,
      reading_count: 20,
      breach_count: 0,
      commit_root: root1,
      breached: 0,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mutated)],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

test record_rejects_bad_root_length() {
  let datum = mk_state(10, 0, root0, 0)
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [state_output(mk_state(20, 0, short_root, 0))],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

test record_rejects_nft_not_preserved() {
  let datum = mk_state(10, 0, root0, 0)
  let no_token =
    Output {
      address: script_addr(),
      value: assets.from_lovelace(2_000_000),
      datum: InlineDatum(mk_state(20, 0, root1, 0)),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [no_token],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

test record_rejects_output_not_at_script() {
  let datum = mk_state(10, 0, root0, 0)
  let off_script =
    Output {
      address: address.from_verification_key(oracle_vkh),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(policy_id, monitor_name, 1),
      datum: InlineDatum(mk_state(20, 0, root1, 0)),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      inputs: [monitor_utxo(monitor_ref, datum)],
      outputs: [off_script],
      extra_signatories: [oracle_vkh],
    }
  can_record_readings(tx, datum, monitor_ref, 0, 0, oracle_vkh) == False
}

// -- close tests --

test close_accepts_with_oracle_sig() {
  let tx =
    Transaction { ..tx_mod.placeholder, extra_signatories: [oracle_vkh] }
  can_close(tx, oracle_vkh) == True
}

test close_rejects_without_oracle_sig() {
  let tx =
    Transaction { ..tx_mod.placeholder, extra_signatories: [other_vkh] }
  can_close(tx, oracle_vkh) == False
}

// -- burn tests --

test burn_accepts_when_negative() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      mint: assets.from_asset(policy_id, monitor_name, -1),
    }
  can_burn(tx, policy_id) == True
}

test burn_rejects_positive_qty() {
  let tx =
    Transaction {
      ..tx_mod.placeholder,
      mint: assets.from_asset(policy_id, monitor_name, 1),
    }
  can_burn(tx, policy_id) == False
}
