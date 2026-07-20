import type { ElementType } from "react";

interface CardProps {
    as?: ElementType;
    className?: string;
    children?: React.ReactNode;
    id?: string;
    [key: string]: unknown;
}

export default function Card({ as: Tag = "section", className = "", children, id, ...rest }: CardProps) {
    return (
        <Tag
            className={`card w-[min(1100px,90%)] mx-auto my-4 rounded-2xl border border-black/6 bg-white/45 p-10 text-left shadow-[0_10px_30px_-10px_rgba(0,0,0,0.05)] backdrop-blur-md dark:border-white/10 dark:bg-[rgba(30,29,28,0.5)] dark:shadow-[0_10px_30px_-10px_rgba(0,0,0,0.3)]${className ? ` ${className}` : ""}`}
            id={id}
            {...rest}
        >
            {children}
        </Tag>
    );
}
