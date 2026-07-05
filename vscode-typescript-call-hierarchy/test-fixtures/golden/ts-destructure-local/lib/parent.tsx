import { Modal } from "./modal";

function usePair(): [boolean, (fn: () => void) => void] {
  return [false, () => {}];
}

function leaf() {
}

export function ParentWithDestructure() {
  const [_p, run] = usePair();
  run(() => {
    leaf();
  });
  return <Modal />;
}
