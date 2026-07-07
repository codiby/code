import { Button, Modal, ModalBackdrop, ModalContainer, ModalDialog, ModalHeader, ModalHeading, ModalBody, ModalFooter, Chip, ChipLabel } from '@heroui/react';
import type { PermissionRequest } from '../lib/claude-client';

interface Props {
  request: PermissionRequest | null;
  onRespond: (requestId: string, allow: boolean) => void;
}

export function PermissionModal({ request, onRespond }: Props) {
  if (!request) return null;

  const inputStr = JSON.stringify(request.input, null, 2);

  return (
    <Modal defaultOpen>
      <ModalBackdrop isDismissable={false}>
        <ModalContainer size="lg" placement="center">
          <ModalDialog>
            <ModalHeader>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <ModalHeading className="text-amber-400">Permission Request</ModalHeading>
                  <Chip size="sm" color="warning" variant="flat">
                    <ChipLabel>{request.toolName}</ChipLabel>
                  </Chip>
                </div>
                {request.title && (
                  <p className="text-sm text-zinc-400 font-normal">{request.title}</p>
                )}
              </div>
            </ModalHeader>
            <ModalBody>
              {request.description && (
                <p className="text-sm text-zinc-300 mb-2">{request.description}</p>
              )}
              <div className="bg-base rounded-lg p-3 max-h-64 overflow-auto">
                <p className="text-xs text-zinc-500 mb-1">Tool Input:</p>
                <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-all m-0 bg-transparent p-0">
                  {inputStr}
                </pre>
              </div>
            </ModalBody>
            <ModalFooter className="flex gap-2 justify-end">
              <Button variant="flat" onPress={() => onRespond(request.requestId, false)}
                className="text-red-400">
                Deny
              </Button>
              <Button onPress={() => onRespond(request.requestId, true)}
                className="bg-green-600 text-white">
                Allow
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
