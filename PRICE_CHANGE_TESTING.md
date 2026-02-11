# Тестирование сценария изменения цены

## Описание сценария

Когда между поиском и верификацией цена или доступность изменились:
- Массив `booking` будет **пустым** `[]` или `null`
- Актуальное предложение придет в массиве `alternativeBooking`
- Клиент должен быть уведомлен об изменениях
- Предложены варианты: бронирование на новых условиях или повторный поиск

## Инструкция для тестирования

### Шаг 1: Получите checksum из Search API

Выполните поиск и сохраните `checksum` из ответа:

```bash
curl -X GET "https://partner.qatl.ru/api/search/v1/properties/8616/room-stays?adults=1&arrivalDate=2026-02-11&departureDate=2026-02-12&currencyCode=RUB" \
  -H "Authorization: Bearer <token>"
```

Из ответа возьмите: `roomStays[0].checksum`

Пример checksum:
```
eyJDaGVja3N1bVdpdGhPdXRFeHRyYXMiOnsiVG90YWxBbW91bnRBZnRlclRheCI6IjE3MDAuMDAiLCJDdXJyZW5jeUNvZGUiOiJSVUIiLCJTdGFydFBlbmFsdHlBbW91bnQiOiIxNzAwLjAwIn0sIkNoZWNrc3VtV2l0aEV4dHJhcyI6eyJUb3RhbEFtb3VudEFmdGVyVGF4IjoiMTcwMC4wMCIsIkN1cnJlbmN5Q29kZSI6IlJVQiIsIlN0YXJ0UGVuYWx0eUFtb3VudCI6IjE3MDAuMDAifX0=
```

### Шаг 2: Декодируйте checksum

```bash
node test-checksum.js decode "eyJDaGVja3N1bVdpdGhPdXRFeHRyYXMi..."
```

Вы получите JSON:
```json
{
  "ChecksumWithOutExtras": {
    "TotalAmountAfterTax": "1700.00",
    "CurrencyCode": "RUB",
    "StartPenaltyAmount": "1700.00"
  },
  "ChecksumWithExtras": {
    "TotalAmountAfterTax": "1700.00",
    "CurrencyCode": "RUB",
    "StartPenaltyAmount": "1700.00"
  }
}
```

### Шаг 3: Измените цену

Отредактируйте JSON, изменив `TotalAmountAfterTax`:

```json
{
  "ChecksumWithOutExtras": {
    "TotalAmountAfterTax": "2500.00",
    "CurrencyCode": "RUB",
    "StartPenaltyAmount": "1700.00"
  },
  "ChecksumWithExtras": {
    "TotalAmountAfterTax": "2500.00",
    "CurrencyCode": "RUB",
    "StartPenaltyAmount": "1700.00"
  }
}
```

### Шаг 4: Закодируйте обратно

```bash
node test-checksum.js encode '{"ChecksumWithOutExtras":{"TotalAmountAfterTax":"2500.00","CurrencyCode":"RUB","StartPenaltyAmount":"1700.00"},"ChecksumWithExtras":{"TotalAmountAfterTax":"2500.00","CurrencyCode":"RUB","StartPenaltyAmount":"1700.00"}}'
```

Получите новый checksum.

### Шаг 5: Тестируйте через фронтенд или тестовый эндпоинт

**Вариант A — через браузер (DevTools):**

1. Откройте страницу бронирования отеля, заполните форму.
2. В DevTools → Network перехватите запрос на `/reservation/quick-book` (или скопируйте тело запроса).
3. В консоли: Copy as fetch → вставьте, в теле замените `roomStay.checksum` на модифицированный checksum из шага 4.
4. Выполните запрос.

**Вариант B — локально через тестовый эндпоинт (без подмены вручную в запросе):**

Эндпоинт `POST /reservation/test-price-change` принимает **то же тело, что и** `quick-book`, плюс поле `overrideChecksum`. Бэкенд подставит `overrideChecksum` в `roomStay` и вызовет тот же сценарий, что и quick-book. Так можно вызвать сценарий изменения цены одной командой.

1. Получите тело запроса quick-book (один раз): откройте бронирование, в Network найдите `quick-book`, правой кнопкой → Copy → Copy as cURL (или Copy as fetch). Либо соберите JSON вручную: `propertyId`, `roomStay` (из ответа `/offer/:id` — в нём уже есть `checksum`), `arrival`, `departure`, `guestsCount`, `customer`, и т.д.
2. Модифицированный checksum получите по шагам 1–4 выше.
3. Вызовите тестовый эндпоинт (замените `YOUR_BASE_URL`, `YOUR_JWT`, `PAYLOAD.json` и `MODIFIED_CHECKSUM` по месту):

```bash
# Сохраните тело quick-book в payload.json, затем добавьте overrideChecksum и отправьте:
curl -X POST "http://localhost:3000/reservation/test-price-change" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT" \
  -d "$(jq '. + {"overrideChecksum": "MODIFIED_CHECKSUM_BASE64"}' payload.json)"
```

Ответ будет таким же, как у quick-book: при эмуляции изменения цены — `priceChanged: true`, `alternativeToken`, `originalPrice`, `alternativePrice` и т.д. Фронт при вызове обычного quick-book с модифицированным checksum (или при вызове test-price-change с overrideChecksum) покажет модалку «Условия изменились».

**Ожидаемый результат:**
- Модалка "Условия изменились"
- Старая цена: 1700 ₽
- Новая цена: 2500 ₽
- Разница: +800 ₽
- Кнопки: "Повторить поиск" и "Принять новые условия"

### Шаг 6: Проверьте логи бэкенда

```
[ReservationService] quickBook verify result:
  - booking type: array
  - booking length: 0
  - bookingToken: false
  - alternativeBooking type: array
  - alternativeBooking length: 1
  - alternativeToken: true

[ReservationService] quickBook: price/availability changed (1700 -> 2500 RUB), NOT creating booking
```

## Структура checksum

```typescript
{
  ChecksumWithOutExtras: {
    TotalAmountAfterTax: string,     // Стоимость с налогами (основная)
    CurrencyCode: string,             // Код валюты (RUB, USD, EUR)
    StartPenaltyAmount: string        // Сумма штрафа при отмене
  },
  ChecksumWithExtras?: {              // Опционально: с доп. услугами
    TotalAmountAfterTax: string,
    CurrencyCode: string,
    StartPenaltyAmount: string
  }
}
```

## Возможные варианты ответа от TravelLine

### 1. Цена НЕ изменилась
```json
{
  "booking": { "createBookingToken": "..." },
  "alternativeBooking": null
}
```

### 2. Цена ИЗМЕНИЛАСЬ
```json
{
  "booking": [],
  "alternativeBooking": { "createBookingToken": "..." }
}
```

### 3. Нет доступности
```json
{
  "booking": [],
  "alternativeBooking": []
}
```

## Ожидаемое поведение системы

| Ситуация | booking | alternativeBooking | Действие |
|----------|---------|-------------------|----------|
| Цена не изменилась | ✅ токен | ❌ нет | Создать бронь сразу |
| Цена изменилась | ❌ пусто | ✅ токен | Показать модалку, ждать подтверждения |
| Нет доступности | ❌ пусто | ❌ пусто | Показать "Нет номеров" |
| Повторное изменение | ❌ пусто | ✅ новый токен | Обновить модалку с новой ценой |

## Код для быстрого тестирования

### Modify checksum в консоли браузера:

```javascript
// 1. Декодировать
const checksum = "eyJDaGVja3N1bVdpdGhPdXRFeHRyYXMi...";
const decoded = JSON.parse(atob(checksum));
console.log(decoded);

// 2. Изменить цену
decoded.ChecksumWithOutExtras.TotalAmountAfterTax = "2500.00";
decoded.ChecksumWithExtras.TotalAmountAfterTax = "2500.00";

// 3. Закодировать обратно
const modified = btoa(JSON.stringify(decoded));
console.log("Modified checksum:", modified);
```
