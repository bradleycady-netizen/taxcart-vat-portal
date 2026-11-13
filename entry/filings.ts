import { buildDeps } from '../src/http/buildDeps.ts';
import { exportFilings, listFilings } from '../src/http/handlers/data.ts';

// GET /api/filings?...            the filings list (JSON)
// GET /api/filings?format=csv&... the same filings as a spreadsheet file (shares this function: the free Vercel plan caps the number of functions)
export function GET(request: Request): Promise<Response> {
  const { deps } = buildDeps(process.env);
  return new URL(request.url).searchParams.get('format') === 'csv' ? exportFilings(request, deps) : listFilings(request, deps);
}
