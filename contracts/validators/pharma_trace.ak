use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction, OutputReference, InlineDatum}

// -- Datum: travels with the NFT through the supply chain --

pub type ChainOfCustody {
  manufacturer: VerificationKeyHash,
  current_holder: VerificationKeyHash,
  batch_id: ByteArray,
  step: Int,
}

// -- Redeemer: which action is being performed? --

pub type Action {
  Transfer { next_holder: VerificationKeyHash }
  Deliver
}

// -- Validator --

validator pharma_trace(manufacturer: VerificationKeyHash) {
  // Mint: manufacturer mints exactly 1 NFT per batch
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    let must_be_signed = list.has(self.extra_signatories, manufacturer)

    let mint_exactly_one =
      when self.mint |> assets.tokens(policy_id) |> dict.to_pairs() is {
        [Pair(_, qty)] -> qty == 1
        _ -> False
      }

    must_be_signed && mint_exactly_one
  }

  // Spend: transfer or deliver the NFT
  spend(
    datum: Option<ChainOfCustody>,
    redeemer: Action,
    _utxo: OutputReference,
    self: Transaction,
  ) {
    expect Some(custody) = datum

    // Current holder must sign in ALL cases
    let holder_signed =
      list.has(self.extra_signatories, custody.current_holder)

    when redeemer is {
      Transfer { next_holder } -> {
        // A continuing output must exist with an updated datum
        let continuing_output_correct =
          list.any(
            self.outputs,
            fn(output) {
              when output.datum is {
                InlineDatum(raw_datum) -> {
                  expect new_custody: ChainOfCustody = raw_datum
                  new_custody.manufacturer == custody.manufacturer && new_custody.current_holder == next_holder && new_custody.batch_id == custody.batch_id && new_custody.step == custody.step + 1
                }
                _ -> False
              }
            },
          )

        holder_signed && continuing_output_correct
      }

      Deliver -> {
        // Delivery: NFT leaves the script address → goes to holder's wallet.
        // No continuing output check — the NFT is permanently non-transferable
        // through this validator once it's at a wallet address.
        holder_signed
      }
    }
  }

  else(_) {
    fail
  }
}
