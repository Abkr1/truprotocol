#!/usr/bin/env bash
# FULL redeploy: fresh token + AZNS + faucet(+minter) + beacon, all on the
# nightly chain, all paid by the sponsored FPC. Writes every address into
# dapp/.env in sequence. One script so the .env chain stays consistent.
export HOME=/root
for d in /root/.nvm/versions/node/*/bin; do [ -x "$d/node" ] && PATH="$d:$PATH"; done
export PATH NODE_NO_WARNINGS=1 NODE_OPTIONS=--dns-result-order=ipv4first
export AZTEC_NODE_URL=https://v5.testnet.rpc.aztec-labs.com
export FEE_MODE=sponsored
# NOTE: PAY_TOKEN_ADDRESS intentionally UNSET -> deploy_testnet deploys a fresh
# 18-decimal test token (operator = admin/minter). deploy_faucet then reads the
# fresh token from dapp/.env and approves the new faucet as its minter.
export SKIP_OPEN_VERIFY=1   # faucet is proven separately; skip the extra account-deploy
cd /mnt/c/Users/USER/Documents/GitHub/trudao || exit 98
echo "===== START FULL REDEPLOY $(date -u) ====="
echo "--- 1/3 token + AZNS ---"
npx tsx scripts/deploy_testnet.ts 2>&1 | tail -30
echo "DEPLOY_TESTNET_EXIT=${PIPESTATUS[0]}"
echo "--- 2/3 faucet (+ set_minter on the fresh token) ---"
npx tsx scripts/deploy_faucet.ts 2>&1 | tail -20
echo "DEPLOY_FAUCET_EXIT=${PIPESTATUS[0]}"
echo "--- 3/3 beacon ---"
npx tsx scripts/deploy_beacon.ts 2>&1 | tail -15
echo "DEPLOY_BEACON_EXIT=${PIPESTATUS[0]}"
echo "===== .env now ====="
grep -E "AZNS_ADDRESS|PAY_TOKEN_ADDRESS|FAUCET_ADDRESS|BEACON_ADDRESS" dapp/.env
echo "===== END $(date -u) ====="
