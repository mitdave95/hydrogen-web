import ListView from "../general/ListView.js";
import TemplateView from "../general/TemplateView.js";

class SessionPickerItemView extends TemplateView {
    constructor(vm) {
        super(vm, true);
        this._onDeleteClick = this._onDeleteClick.bind(this);
        this._onClearClick = this._onClearClick.bind(this);
    }

    _onDeleteClick(event) {
        event.stopPropagation();
        event.preventDefault();
        if (confirm("Are you sure?")) {
            this.viewModel.delete();
        }
    }

    _onClearClick(event) {
        event.stopPropagation();
        event.preventDefault();
        this.viewModel.clear();
    }

    render(t) {
        const deleteButton = t.button({
            disabled: vm => vm.isDeleting,
            onClick: this._onDeleteClick,
        }, "Delete");
        const clearButton = t.button({
            disabled: vm => vm.isClearing,
            onClick: this._onClearClick,
        }, "Clear");

        const json = t.if(vm => vm.json, t => {
            return t.div(t.pre(vm => vm.json));
        });

        const userName = t.span({className: "userId"}, vm => vm.userId);
        const errorMessage = t.if(vm => vm.error, t => t.span({className: "error"}, vm => vm.error));
        return t.li([t.div({className: "sessionInfo"}, [userName, errorMessage, clearButton, deleteButton]), json]);
    }
}

export default class SessionPickerView extends TemplateView {
    mount() {
        this._sessionList = new ListView({
            list: this.viewModel.sessions,
            onItemClick: (item, event) => {
                if (event.target.closest(".sessionInfo")) {
                    this.viewModel.pick(item.viewModel.id);
                }
            },
        }, sessionInfo => {
            return new SessionPickerItemView(sessionInfo);
        });
        return super.mount();
    }

    render(t) {
        return t.div({className: "SessionPickerView"}, [
            t.h1(["Pick a session"]),
            this._sessionList.mount(),
            t.p(t.button({onClick: () => this.viewModel.cancel()}, ["Log in to a new session instead"])),
            t.p(t.button({onClick: () => this.viewModel.import(prompt("JSON"))}, ["Import Session JSON"])),
            t.p(t.a({href: "https://github.com/bwindels/brawl-chat"}, ["Brawl on Github"]))
        ]);
    }

    unmount() {
        super.unmount();
        this._sessionList.unmount();
    }
}