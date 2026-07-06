$FIREBASE_ID_TOKEN = "PASTE_YOUR_ID_TOKEN_HERE"
$FIREBASE_UID = "PASTE_YOUR_FIREBASE_UID_HERE"

1..30 | ForEach-Object {
  curl.exe -s -o NUL -w "%{http_code}`n" `
    -X POST https://portility-proxy.andrewjanis.workers.dev/use `
    -H "Content-Type: application/json" `
    -H "Authorization: Bearer $FIREBASE_ID_TOKEN" `
    -d "{`"firebaseUid`":`"$FIREBASE_UID`",`"feature`":`"port_my_chat_pro`"}"
}
