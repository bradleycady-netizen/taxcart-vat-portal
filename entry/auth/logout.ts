import { buildDeps } from '../../src/http/buildDeps.ts';
import { logout } from '../../src/http/handlers/auth.ts';

export function POST(request: Request): Promise<Response> {
  return logout(request, buildDeps(process.env).deps);
}
