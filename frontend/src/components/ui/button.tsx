import type {ButtonHTMLAttributes} from 'react';
import {cva,type VariantProps} from 'class-variance-authority';
import {clsx} from 'clsx';import {twMerge} from 'tailwind-merge';
const variants=cva('ui-button inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40',{variants:{variant:{default:'ui-primary',primary:'ui-primary',secondary:'ui-secondary',ghost:'ui-ghost',danger:'ui-danger'},size:{default:'h-9 px-3',sm:'h-8 px-2',icon:'h-8 w-8'}},defaultVariants:{variant:'secondary',size:'default'}});
export function Button({className,variant,size,...props}:ButtonHTMLAttributes<HTMLButtonElement>&VariantProps<typeof variants>){return <button type="button" className={twMerge(clsx(variants({variant,size}),className))} {...props}/>;}
