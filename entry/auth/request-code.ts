import { buildDeps } from '../../src/http/buildDeps.ts';
import { requestCode } from '../../src/http/handlers/auth.ts';

export function POST(request: Request): Promise<Response> {
  return requestCode(request, buildDeps(process.env).deps);
}
