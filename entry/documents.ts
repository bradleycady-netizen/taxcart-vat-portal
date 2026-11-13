import { buildDeps } from '../src/http/buildDeps.ts';
import { downloadDocument } from '../src/http/handlers/data.ts';

export function GET(request: Request): Promise<Response> {
  return downloadDocument(request, buildDeps(process.env).deps);
}
