export const readable = characteristic => !!characteristic && characteristic.properties?.read !== false;
export const writable = characteristic => !!characteristic && (characteristic.properties?.write === true || characteristic.properties?.writeWithoutResponse === true || characteristic.properties?.write === undefined);
export const optionalUnsupported = error => ['NotFoundError','NotSupportedError'].includes(error.name);
export function characteristicProperties(characteristic) {
  return Object.fromEntries(['read','write','writeWithoutResponse','notify','indicate'].map(name=>[name,!!characteristic.properties?.[name]]));
}
export function writeCharacteristic(characteristic, value) {
  const properties=characteristic.properties??{};
  if(properties.write!==false&&typeof characteristic.writeValueWithResponse==='function')return characteristic.writeValueWithResponse(value);
  if(properties.writeWithoutResponse&&typeof characteristic.writeValueWithoutResponse==='function')return characteristic.writeValueWithoutResponse(value);
  throw new DOMException('Characteristic does not support an available write procedure','NotSupportedError');
}
