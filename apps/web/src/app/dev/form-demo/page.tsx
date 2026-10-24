import { notFound } from 'next/navigation';
import { FormRenderer } from '../../../components/FormRenderer';
import { demoForm } from '../../../fixtures/demo-form';

export default function FormDemoPage() {
  // Dev-only page with synthetic data. The real public form (/f/[token]) arrives in Prompt 3.2.
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <>
      <h1>Employee details (demo form)</h1>
      <FormRenderer definition={demoForm} />
    </>
  );
}
