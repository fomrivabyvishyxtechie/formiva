import { forwardToApi } from '../../../../../lib/api-proxy';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return forwardToApi(request, (await params).token, '');
}
