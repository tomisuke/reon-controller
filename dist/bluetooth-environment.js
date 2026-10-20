export function bluetoothProblem(scope=globalThis) {
  if(scope.isSecureContext===false)return 'Bluetooth接続にはHTTPSが必要です。公開URLを開いてください。';
  if(typeof scope.navigator?.bluetooth?.requestDevice!=='function')return 'このブラウザはBluetooth接続に対応していません。Chrome / Edgeなど対応ブラウザで開いてください。';
  const policy=scope.document?.permissionsPolicy??scope.document?.featurePolicy;
  if(policy?.allowsFeature&&policy.allowsFeature('bluetooth')===false)return 'この表示ではBluetoothの使用が制限されています。URLをChrome / Edgeで直接開いてください。';
  return null;
}

export function connectionError(error,stage='selecting',operation='') {
  if(error.name==='AbortError')return null;
  if(error.name==='NotFoundError')return stage==='selecting'?'デバイスが選択されませんでした。本体ボタンを約2秒押して青いランプを点滅させ、もう一度選択してください。':'本体に必要なBluetoothサービスまたは項目が見つかりません。モデルとファームウェアの互換性を確認してください。';
  if(error.name==='SecurityError'||error.name==='NotAllowedError')return 'Bluetoothの利用が許可されていません。URLをChrome / Edgeで直接開き、ブラウザとOSのBluetooth権限を確認してください。';
  if(error.name==='TimeoutError')return stage==='selecting'?'デバイス選択の応答がありません。選択画面が開かない場合はURLをコピーし、Chrome / Edgeで直接開いてください。':'本体との接続が時間切れになりました。本体を近くに置き、再接続してください。';
  if(error.name==='NotSupportedError')return stage==='selecting'?'この環境ではBluetoothのデバイス選択を利用できません。':'本体との通信処理が対応していません'+(operation?`（${operation}）`:'')+'。接続の詳細を確認してください。';
  return `本体との接続に失敗しました。本体ボタンを約2秒押し、再接続してください。（${error.name||'Error'}）`;
}
