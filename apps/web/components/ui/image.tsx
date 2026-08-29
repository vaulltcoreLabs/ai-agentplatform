import { forwardRef } from "react";

type ImageProps = {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  className?: string;
  priority?: boolean;
  sizes?: string;
  fill?: boolean;
  placeholder?: string;
  blurDataURL?: string;
  onLoad?: () => void;
  onError?: () => void;
  onClick?: () => void;
  style?: React.CSSProperties;
};

export const Image = forwardRef<HTMLImageElement, ImageProps>(
  function Image(
    { src, alt, width, height, className, fill, style, onClick },
    _ref,
  ) {
    const isFill = Boolean(fill);
    const styleObj: React.CSSProperties = {
      ...(isFill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : {}),
      ...style,
    };

    return (
      <img
        src={src}
        alt={alt}
        width={!isFill ? width : undefined}
        height={!isFill ? height : undefined}
        className={className}
        style={styleObj}
        onClick={onClick}
      />
    );
  },
);

