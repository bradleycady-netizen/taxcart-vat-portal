import { buildDeps } from '../src/http/buildDeps.ts';
import { vatRoute } from '../src/http/handlers/vat.ts';

export function GET(request: Request): Promise<Response> {
  return vatRoute(request, buildDeps(process.env).deps);
}
export function POST(request: Request): Promise<Response> {
  return vatRoute(request, buildDeps(process.env).deps);
}
