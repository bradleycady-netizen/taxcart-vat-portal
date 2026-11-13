import { buildDeps } from '../src/http/buildDeps.ts';
import { staffRoute } from '../src/http/handlers/staffRouter.ts';

export function GET(request: Request): Promise<Response> {
  const { deps, staff } = buildDeps(process.env);
  return staffRoute(request, deps, staff);
}
export function POST(request: Request): Promise<Response> {
  const { deps, staff } = buildDeps(process.env);
  return staffRoute(request, deps, staff);
}
