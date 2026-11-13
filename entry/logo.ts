import { buildDeps } from '../src/http/buildDeps.ts';
import { getLogo } from '../src/http/handlers/logo.ts';

export function GET(request: Request): Promise<Response> {
  return getLogo(request, buildDeps(process.env).deps);
}
