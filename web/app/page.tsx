import type { Metadata } from 'next';
import Welcome from '@/ui/Welcome';

export const metadata: Metadata = {
  title: 'Likuloka 3D: building editor in the browser',
  description: 'Draw buildings, levels, walls, doors and windows in 3D, to the millimetre, with plans, schedules, DXF and IFC from the same model.',
};

export default function Page() {
  return <Welcome />;
}
