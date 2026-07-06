$FIREBASE_ID_TOKEN = "PASTE_YOUR_ID_TOKEN_HERE"
$FIREBASE_UID = "PASTE_YOUR_FIREBASE_UID_HERE"

$headers = @{ 'Authorization' = "Bearer $FIREBASE_ID_TOKEN" }
$body = @{ firebaseUid = $FIREBASE_UID; feature = 'port_my_chat_pro' } | ConvertTo-Json

1..30 | ForEach-Object {
  try {
    $resp = Invoke-WebRequest -Uri 'https://portility-proxy.andrewjanis.workers.dev/use' `
      -Method Post -Headers $headers -ContentType 'application/json' -Body $body -ErrorAction Stop
    Write-Output $resp.StatusCode
  } catch {
    Write-Output $_.Exception.Response.StatusCode.value__
  }
}
