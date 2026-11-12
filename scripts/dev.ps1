param([ValidateSet('up','status','down','mine')][string]$Action='up',[int]$Blocks=1)
$ErrorActionPreference='Stop'
$Project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $Project
$env:DOCKER_CONFIG = Join-Path $Project '.runtime\docker-config'
New-Item -ItemType Directory -Path $env:DOCKER_CONFIG -Force | Out-Null
$env:npm_config_cache = Join-Path $Project '.runtime\npm-cache'
function Dc { & docker compose @args; if($LASTEXITCODE -ne 0){throw "docker compose failed ($LASTEXITCODE)"} }
function Btc([string[]]$BtcArgs) { $result=& docker compose exec -T bitcoin bitcoin-cli -regtest -rpcuser=dakar-regtest -rpcpassword=local-only-regtest @BtcArgs; if($LASTEXITCODE -ne 0){throw "Bitcoin RPC failed: $BtcArgs"}; return $result }
function Ln([string]$Name,[string[]]$LnArgs) { $result=& docker compose exec -T $Name lncli --lnddir=/data --network=regtest @LnArgs; if($LASTEXITCODE -ne 0){throw "LND $Name failed: $LnArgs"}; return $result }
function Wait-Ready([scriptblock]$Check,[string]$Label) { for($i=0;$i -lt 90;$i++){try{ $value=& $Check; if($value){return $value} }catch{};Start-Sleep -Seconds 2};throw "Timed out waiting for $Label" }
if($Action -eq 'down'){Dc down;exit 0}
if($Action -eq 'status'){Dc ps;exit 0}
if($Action -eq 'mine'){
  if($Blocks -lt 1 -or $Blocks -gt 200){throw 'Blocks must be between 1 and 200'}
  $address=Btc @('-rpcwallet=miner','getnewaddress')
  Btc @('-rpcwallet=miner','generatetoaddress',"$Blocks",$address)
  exit 0
}
Dc up -d
Wait-Ready { Btc @('getblockchaininfo') } 'Bitcoin Core' | Out-Null
$walletList=(Btc @('listwalletdir') | ConvertFrom-Json).wallets.name
if('miner' -notin $walletList){ Btc @('createwallet','miner') | Out-Null }
elseif('miner' -notin ((Btc @('listwallets')) | ConvertFrom-Json)){ Btc @('loadwallet','miner') | Out-Null }
$address=Btc @('-rpcwallet=miner','getnewaddress')
$height=(Btc @('getblockcount')) -as [int]
if($height -lt 110){ Btc @('-rpcwallet=miner','generatetoaddress',"$([Math]::Max(110-$height,0))",$address) | Out-Null }
foreach($name in @('buyer','seller','courier')){Wait-Ready { Ln $name @('getinfo') } "$name LND node" | Out-Null}
$funded=$false
foreach($name in @('buyer','seller')){
  $balance=(Ln $name @('walletbalance') | ConvertFrom-Json).confirmed_balance -as [int64]
  if($balance -lt 300000){
    $receive=Ln $name @('newaddress','p2wkh') | ConvertFrom-Json
    Btc @('-rpcwallet=miner','sendtoaddress',$receive.address,'0.01') | Out-Null
    $funded=$true
  }
}
if($funded){Btc @('-rpcwallet=miner','generatetoaddress','6',$address) | Out-Null}
$sellerInfo=Ln 'seller' @('getinfo') | ConvertFrom-Json
$courierInfo=Ln 'courier' @('getinfo') | ConvertFrom-Json
$buyerChannels=Ln 'buyer' @('listchannels') | ConvertFrom-Json
$buyerPendingResponse=Ln 'buyer' @('pendingchannels') | ConvertFrom-Json
$sellerPendingResponse=Ln 'seller' @('pendingchannels') | ConvertFrom-Json
$buyerPending=@($buyerPendingResponse.pending_open_channels | Where-Object { $null -ne $_ })
$sellerPending=@($sellerPendingResponse.pending_open_channels | Where-Object { $null -ne $_ })
$confirmChannels=($buyerPending.Count -gt 0 -or $sellerPending.Count -gt 0)
if(@($buyerChannels.channels | Where-Object remote_pubkey -eq $sellerInfo.identity_pubkey).Count -eq 0){
  if($buyerPending.Count -eq 0){
    try{Ln 'buyer' @('connect',"$($sellerInfo.identity_pubkey)@seller:9735") | Out-Null}catch{}
    Ln 'buyer' @('openchannel',"--node_key=$($sellerInfo.identity_pubkey)",'--local_amt=250000') | Out-Null
    $confirmChannels=$true
  }
}
$sellerChannels=Ln 'seller' @('listchannels') | ConvertFrom-Json
if(@($sellerChannels.channels | Where-Object remote_pubkey -eq $courierInfo.identity_pubkey).Count -eq 0){
  if($sellerPending.Count -eq 0){
    try{Ln 'seller' @('connect',"$($courierInfo.identity_pubkey)@courier:9735") | Out-Null}catch{}
    Ln 'seller' @('openchannel',"--node_key=$($courierInfo.identity_pubkey)",'--local_amt=150000') | Out-Null
    $confirmChannels=$true
  }
}
if($confirmChannels){Btc @('-rpcwallet=miner','generatetoaddress','6',$address) | Out-Null}
foreach($name in @('buyer','seller','courier')){Wait-Ready { (Ln $name @('listchannels') | ConvertFrom-Json).channels | Where-Object active } "$name channels" | Out-Null}
$permissions=@{
  buyer=@('uri:/lnrpc.Lightning/GetInfo','uri:/lnrpc.Lightning/LookupInvoice','uri:/routerrpc.Router/SendPaymentV2','uri:/routerrpc.Router/TrackPaymentV2')
  seller=@('uri:/lnrpc.Lightning/GetInfo','uri:/lnrpc.Lightning/LookupInvoice','uri:/routerrpc.Router/SendPaymentV2','uri:/routerrpc.Router/TrackPaymentV2','uri:/invoicesrpc.Invoices/AddHoldInvoice','uri:/invoicesrpc.Invoices/SettleInvoice','uri:/invoicesrpc.Invoices/CancelInvoice')
  courier=@('uri:/lnrpc.Lightning/GetInfo','uri:/lnrpc.Lightning/LookupInvoice','uri:/invoicesrpc.Invoices/AddHoldInvoice','uri:/invoicesrpc.Invoices/SettleInvoice','uri:/invoicesrpc.Invoices/CancelInvoice')
}
foreach($name in @('buyer','seller','courier')){
  $dest=Join-Path $Project ".runtime\$name"; New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Ln $name (@('bakemacaroon','--save_to=/data/runtime.macaroon')+$permissions[$name]) | Out-Null
  & docker compose cp "$name`:/data/runtime.macaroon" (Join-Path $dest 'runtime.macaroon') | Out-Null
  if($LASTEXITCODE -ne 0){throw "Could not copy $name macaroon"}
  & docker compose cp "$name`:/data/tls.cert" (Join-Path $dest 'tls.cert') | Out-Null
  if($LASTEXITCODE -ne 0){throw "Could not copy $name TLS certificate"}
}
$releasePath=Join-Path $Project '.runtime\release.key'
if(-not(Test-Path -LiteralPath $releasePath)){
  $keyBytes=New-Object 'System.Byte[]' 32
  $rng=[System.Security.Cryptography.RandomNumberGenerator]::Create()
  try{$rng.GetBytes($keyBytes)}finally{$rng.Dispose()}
  [System.IO.File]::WriteAllBytes($releasePath,$keyBytes)
}
$envPath=Join-Path $Project '.env'
if(-not(Test-Path -LiteralPath $envPath)){
  @'
APP_PORT=3000
APP_ORIGIN=http://127.0.0.1:3000
DATABASE_PATH=./.runtime/app.sqlite
BITCOIN_NETWORK=regtest
BUYER_LND_URL=https://127.0.0.1:8081
SELLER_LND_URL=https://127.0.0.1:8082
COURIER_LND_URL=https://127.0.0.1:8083
BUYER_TLS_CERT=./.runtime/buyer/tls.cert
SELLER_TLS_CERT=./.runtime/seller/tls.cert
COURIER_TLS_CERT=./.runtime/courier/tls.cert
BUYER_MACAROON=./.runtime/buyer/runtime.macaroon
SELLER_MACAROON=./.runtime/seller/runtime.macaroon
COURIER_MACAROON=./.runtime/courier/runtime.macaroon
RELEASE_KEY_FILE=./.runtime/release.key
'@ | Set-Content -LiteralPath $envPath -Encoding utf8
}
if(-not(Test-Path -LiteralPath 'node_modules')){npm ci --no-audit --no-fund;if($LASTEXITCODE -ne 0){throw 'npm install failed'}}
npm run build
if($LASTEXITCODE -ne 0){throw 'Build failed'}
Write-Host 'Open http://127.0.0.1:3000. Demo access codes are in .runtime/demo-access.json after the server starts.'
npm start
