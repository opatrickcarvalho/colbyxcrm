// Without this, dynamic dashboard routes skip prefetching and show no feedback until the server responds (Next docs: "Dynamic routes without loading.tsx").
export default function DashboardLoading() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}
