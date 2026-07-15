import { useRef } from 'react';
import { useBrowserPreviewBounds } from '../BrowserPanel';

export function FocusBrowserAnchor(props: {
  label: string;
  url: string;
  title: string;
  openSeq: number;
  cookieJar: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useBrowserPreviewBounds({
    hostRef,
    label: props.label,
    url: props.url,
    title: props.title,
    openSeq: props.openSeq,
    cookieJar: props.cookieJar,
    visible: false,
  });
  return (
    <div
      ref={hostRef}
      aria-hidden
      className="absolute inset-0 pointer-events-none invisible"
    />
  );
}
