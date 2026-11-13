import { buildDeps } from '../src/http/buildDeps.ts';
import { getSession } from '../src/http/handlers/auth.ts';

export function GET(request: Request): Promise<Response> {
  return getSession(request, buildDeps(process.env).deps);
}
