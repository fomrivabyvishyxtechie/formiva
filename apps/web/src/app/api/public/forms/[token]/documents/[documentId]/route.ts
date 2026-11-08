import { forwardToApi } from '../../../../../../../lib/api-proxy';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ token: string; documentId: string }> },
) {
  const { token, documentId } = await params;
  return forwardToApi(request, token, `/documents/${documentId}`);
}
