import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@appica/ui-react/alert-dialog";
import { Button } from "@appica/ui-react/button";
import { Check, ShieldCheck } from "lucide-react";

interface ModeDialogProps {
  open: boolean;
  currentMode: "test" | "production";
  onClose: () => void;
  onConfirm: () => void;
  resourceLabel?: string;
}

export function ModeDialog({
  open,
  currentMode,
  onClose,
  onConfirm,
  resourceLabel = "",
}: ModeDialogProps) {
  const target = currentMode === "test" ? "生产模式" : "测试模式";

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <AlertDialogContent className="mode-dialog" frame={false}>
        <AlertDialogHeader className="mode-dialog-header">
          <span className="dialog-icon">
            <ShieldCheck aria-hidden="true" />
          </span>
          <p className="eyebrow">运营操作</p>
          <AlertDialogTitle id="mode-dialog-title">
            切换{resourceLabel ? `${resourceLabel}到` : "到"}
            {target}？
          </AlertDialogTitle>
          <AlertDialogDescription>
            切换前系统会检查目标模式的配置，并阻止存在未知结果时切换。
            所有配置变更都会写入审计日志。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="mode-dialog-body">
          <div className="dialog-checks">
            <span>
              <Check size={15} aria-hidden="true" />
              网关路由检查
            </span>
            <span>
              <Check size={15} aria-hidden="true" />
              未决订单检查
            </span>
            <span>
              <Check size={15} aria-hidden="true" />
              乐观版本校验
            </span>
          </div>
        </AlertDialogBody>
        <AlertDialogFooter className="dialog-actions">
          <AlertDialogClose
            render={
              <Button variant="soft" size="md" type="button">
                取消
              </Button>
            }
          />
          <Button variant="primary" size="md" type="button" onClick={onConfirm}>
            确认切换
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
