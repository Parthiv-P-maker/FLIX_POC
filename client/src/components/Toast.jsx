import { useApp } from '../store.jsx';

export default function Toast() {
  const { toastMsg } = useApp();
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {toastMsg && <div className="toast neu" key={toastMsg.id}>{toastMsg.message}</div>}
    </div>
  );
}
