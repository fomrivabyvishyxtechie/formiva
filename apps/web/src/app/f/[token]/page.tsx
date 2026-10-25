import type { Metadata } from 'next';
import { PublicForm } from '../../../components/PublicForm';

export const metadata: Metadata = { title: 'Your form', robots: { index: false, follow: false } };

export default async function PublicFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicForm token={token} />;
}
