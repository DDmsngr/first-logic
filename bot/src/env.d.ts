// Минимум типов среды Cloudflare Workers — чтобы проверять код tsc без пакета workers-types.
interface ExecutionContext { waitUntil(p: Promise<unknown>): void }
interface ScheduledEvent { cron: string; scheduledTime: number }
