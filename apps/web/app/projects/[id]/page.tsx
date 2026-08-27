import { Console } from '../../../components/console';
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Console view={{ kind: 'project', id }} />;
}
