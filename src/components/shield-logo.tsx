export function ShieldLogo({ className }: { className?: string }) {
  return (
    <img
      src="/logo.svg"
      alt=""
      width={32}
      height={32}
      className={className}
      draggable={false}
    />
  );
}
