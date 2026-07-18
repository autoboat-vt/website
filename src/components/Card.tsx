import type { ElementType } from "react";

interface CardProps {
    as?: ElementType;
    className?: string;
    children?: React.ReactNode;
    id?: string;
    [key: string]: unknown;
}

/**
 * Generic card container matching the original `.card` styling.
 */
export default function Card({ as: Tag = "section", className = "", children, id, ...rest }: CardProps) {
    return (
        <Tag className={`card${className ? ` ${className}` : ""}`} id={id} {...rest}>
            {children}
        </Tag>
    );
}
