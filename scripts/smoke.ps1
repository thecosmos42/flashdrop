param([string]$BaseUrl='http://127.0.0.1:3000')
$ErrorActionPreference='Stop'
$Project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$codes=Get-Content -LiteralPath (Join-Path $Project '.runtime/demo-access.json') -Raw | ConvertFrom-Json

function Login([string]$Role,[string]$Code) {
  $session=New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $body=@{role=$Role;code=$Code}|ConvertTo-Json -Compress
  $result=Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/sessions" -ContentType 'application/json' -Body $body -WebSession $session
  return @{session=$session;csrf=$result.csrf}
}
function Api([hashtable]$Actor,[string]$Method,[string]$Path,[object]$Body=$null) {
  $headers=@{}
  if($Method -ne 'Get'){$headers['x-csrf']=$Actor.csrf;$headers['Idempotency-Key']=[guid]::NewGuid().ToString()}
  $options=@{Method=$Method;Uri="$BaseUrl/api$Path";WebSession=$Actor.session;Headers=$headers}
  if($null -ne $Body){$options.ContentType='application/json';$options.Body=($Body|ConvertTo-Json -Compress -Depth 5)}
  return Invoke-RestMethod @options
}
function Wait-Order([hashtable]$Actor,[string]$Id,[scriptblock]$Ready,[string]$Label) {
  for($i=0;$i -lt 90;$i++){
    $order=Api $Actor 'Get' "/orders/$Id"
    if(& $Ready $order){return $order}
    Start-Sleep -Seconds 2
  }
  throw "Timed out waiting for $Label. Check the order and LND state before trying another payment."
}

$buyer=Login 'buyer' $codes.buyer
$seller=Login 'seller' $codes.seller
$courier=Login 'courier' $codes.courier
$created=Api $seller 'Post' '/orders' @{description='Demo basket';quantity=1;goodsSat=10000;deliverySat=1000}
$id=$created.id
$bytes=New-Object 'System.Byte[]' 32
$rng=[System.Security.Cryptography.RandomNumberGenerator]::Create()
try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
$secret=[BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
$sha=[System.Security.Cryptography.SHA256]::Create()
try{$hash=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
Api $buyer 'Post' "/orders/$id/hash" @{hash=$hash} | Out-Null
Wait-Order $buyer $id {param($o) $o.invoice -and $o.buyerInvoiceState -eq 'OPEN'} 'buyer hold invoice' | Out-Null
Api $buyer 'Post' "/orders/$id/fund" @{} | Out-Null
Wait-Order $buyer $id {param($o) $o.buyerInvoiceState -eq 'ACCEPTED' -and $o.buyerPaymentState -eq 'IN_FLIGHT'} 'buyer payment hold' | Out-Null
Api $seller 'Post' "/orders/$id/prepare-dispatch" @{} | Out-Null
$ready=Wait-Order $seller $id {param($o) $o.phase -eq 'READY_FOR_PICKUP'} 'courier payment hold'
if($ready.courierInvoiceState -ne 'ACCEPTED' -or $ready.courierPaymentState -ne 'IN_FLIGHT'){throw 'Courier payment is not held'}
Api $courier 'Post' "/orders/$id/pickup" @{} | Out-Null
Api $courier 'Post' "/orders/$id/release" @{hash=$hash;secret=$secret} | Out-Null
$done=Wait-Order $buyer $id {param($o) $o.phase -eq 'COMPLETED'} 'both payments to settle'
if($done.buyerPaymentState -ne 'SUCCEEDED' -or $done.courierPaymentState -ne 'SUCCEEDED'){throw 'Both payments are not confirmed'}
Write-Host "PASS: order $id completed; buyer and courier payments confirmed."
