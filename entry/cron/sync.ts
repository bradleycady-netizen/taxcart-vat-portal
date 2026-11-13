import { buildDeps } from '../../src/http/buildDeps.ts';
import { handleSyncCron } from '../../src/http/handlers/cron.ts';

// Vercel's scheduler calls this with GET; POST is allowed so you can trigger it by hand with curl.
export function GET(request: Request): Promise<Response> {
  return handleSyncCron(request, buildDeps(process.env).cron);
}
export function POST(request: Request): Promise<Response> {
  return handleSyncCron(request, buildDeps(process.env).cron);
}
