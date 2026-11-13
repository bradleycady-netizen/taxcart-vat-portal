import { buildDeps } from '../../src/http/buildDeps.ts';
import { verifyCode } from '../../src/http/handlers/auth.ts';

export function POST(request: Request): Promise<Response> {
  return verifyCode(request, buildDeps(process.env).deps);
}
