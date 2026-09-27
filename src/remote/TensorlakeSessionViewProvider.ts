import * as vscode from "vscode";

export class TensorlakeSessionViewProvider
  implements vscode.TreeDataProvider<never>
{
  readonly onDidChangeTreeData:
    | vscode.Event<never | undefined | null | void>
    | undefined = undefined;

  getTreeItem(element: never): vscode.TreeItem {
    return element;
  }

  getChildren(): never[] {
    return [];
  }
}
