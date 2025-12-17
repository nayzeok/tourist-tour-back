import { BadRequestException } from '@nestjs/common'

export function parseDatesRange(dates: string): {
  arrival: string
  departure: string
} {
  const [rawArrival, rawDeparture] = dates.split('-').map((s) => s.trim())
  if (!rawArrival || !rawDeparture) {
    throw new BadRequestException(
      'dates must be in format DD.MM.YYYY-DD.MM.YYYY',
    )
  }

  const [d1, m1, y1] = rawArrival.split('.').map(Number)
  const [d2, m2, y2] = rawDeparture.split('.').map(Number)

  const parts = [d1, m1, y1, d2, m2, y2]
  if (parts.some((part) => !Number.isFinite(part))) {
    throw new BadRequestException('dates are invalid')
  }

  const arrival = new Date(Date.UTC(y1, m1 - 1, d1))
  const departure = new Date(Date.UTC(y2, m2 - 1, d2))

  const arrivalValid =
    arrival.getUTCFullYear() === y1 &&
    arrival.getUTCMonth() + 1 === m1 &&
    arrival.getUTCDate() === d1
  const departureValid =
    departure.getUTCFullYear() === y2 &&
    departure.getUTCMonth() + 1 === m2 &&
    departure.getUTCDate() === d2

  if (!arrivalValid || !departureValid) {
    throw new BadRequestException('dates are invalid')
  }

  const pad = (value: number) => String(value).padStart(2, '0')
  const format = (date: Date) => {
    const year = date.getUTCFullYear()
    const month = pad(date.getUTCMonth() + 1)
    const day = pad(date.getUTCDate())
    return `${year}-${month}-${day}`
  }

  return { arrival: format(arrival), departure: format(departure) }
}

export function formatRuDate(isoLocal: string): string {
  // "2025-10-19T23:39" -> "19.10.2025"
  const d = new Date(isoLocal)
  if (Number.isNaN(+d)) return isoLocal
  return d.toLocaleDateString('ru-RU')
}
