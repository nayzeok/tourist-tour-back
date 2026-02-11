/**
 * Утилита для тестирования изменения цены через подмену checksum
 *
 * Использование:
 * 1. Получите checksum из ответа Search API
 * 2. Запустите: node test-checksum.js decode <checksum>
 * 3. Измените TotalAmountAfterTax в JSON
 * 4. Запустите: node test-checksum.js encode '<json>'
 */

const action = process.argv[2]
const input = process.argv[3]

if (!action || !input) {
  console.log('Usage:')
  console.log('  Decode: node test-checksum.js decode <base64-checksum>')
  console.log('  Encode: node test-checksum.js encode \'<json-string>\'')
  console.log('')
  console.log('Example:')
  console.log('  node test-checksum.js decode eyJDaGVja3N1bVdpdGhPdXRFeHRyYXMi...')
  console.log('  node test-checksum.js encode \'{"ChecksumWithOutExtras":{"TotalAmountAfterTax":"2000.00",...}}\'')
  process.exit(1)
}

if (action === 'decode') {
  try {
    const decoded = Buffer.from(input, 'base64').toString('utf-8')
    const json = JSON.parse(decoded)
    console.log('Decoded checksum:')
    console.log(JSON.stringify(json, null, 2))
    console.log('')
    console.log('To modify price:')
    console.log('1. Change TotalAmountAfterTax in ChecksumWithOutExtras')
    console.log('2. Change TotalAmountAfterTax in ChecksumWithExtras (if present)')
    console.log('3. Optionally change StartPenaltyAmount')
    console.log('4. Encode back: node test-checksum.js encode \'<modified-json>\'')
  } catch (error) {
    console.error('Error decoding:', error.message)
    process.exit(1)
  }
}

if (action === 'encode') {
  try {
    const json = JSON.parse(input)
    const encoded = Buffer.from(JSON.stringify(json)).toString('base64')
    console.log('Encoded checksum:')
    console.log(encoded)
    console.log('')
    console.log('Use this checksum in your booking request to test price change scenario')
  } catch (error) {
    console.error('Error encoding:', error.message)
    process.exit(1)
  }
}
