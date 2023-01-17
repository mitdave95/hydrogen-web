/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {TimelineViewModel} from "./timeline/TimelineViewModel.js";
import {ComposerViewModel} from "./ComposerViewModel.js"
import {CallViewModel} from "./CallViewModel"
import {PickMapObservableValue} from "../../../observable/value/PickMapObservableValue";
import {avatarInitials, getIdentifierColorNumber, getAvatarHttpUrl} from "../../avatar";
import {ErrorReportViewModel} from "../../ErrorReportViewModel";
import {ViewModel} from "../../ViewModel";
import {imageToInfo} from "../common.js";
import {LocalMedia} from "../../../matrix/calls/LocalMedia";
import {ErrorViewModel} from "../../ErrorViewModel";
// TODO: remove fallback so default isn't included in bundle for SDK users that have their custom tileClassForEntry
// this is a breaking SDK change though to make this option mandatory
import {tileClassForEntry as defaultTileClassForEntry} from "./timeline/tiles/index";

export class RoomViewModel extends ErrorReportViewModel {
    constructor(options) {
        super(options);
        const {room, tileClassForEntry} = options;
        this._room = room;
        this._timelineVM = null;
        this._tileClassForEntry = tileClassForEntry ?? defaultTileClassForEntry;
        this._tileOptions = undefined;
        this._onRoomChange = this._onRoomChange.bind(this);
        this._composerVM = null;
        if (room.isArchived) {
            this._composerVM = new ArchivedViewModel(this.childOptions({archivedRoom: room}));
        } else {
            this._composerVM = new ComposerViewModel(this);
        }
        this._clearUnreadTimout = null;
        this._closeUrl = this.urlCreator.urlUntilSegment("session");
        this._setupCallViewModel();
    }

    _setupCallViewModel() {
        // pick call for this room with lowest key
        const calls = this.getOption("session").callHandler.calls;
        this._callObservable = new PickMapObservableValue(calls.filterValues(c => {
            return c.roomId === this._room.id && c.hasJoined;
        }));
        this._callViewModel = undefined;
        this.track(this._callObservable.subscribe(call => {
            if (call && this._callViewModel && call.id === this._callViewModel.id) {
                return;
            }
            this._callViewModel = this.disposeTracked(this._callViewModel);
            if (call) {
                this._callViewModel = this.track(new CallViewModel(this.childOptions({call, room: this._room})));
            }
            this.emitChange("callViewModel");
        }));
        const call = this._callObservable.get();
        // TODO: cleanup this duplication to create CallViewModel
        if (call) {
            this._callViewModel = this.track(new CallViewModel(this.childOptions({call, room: this._room})));
        }
    }

    async load() {
        this._room.on("change", this._onRoomChange);
        try {
            const timeline = await this._room.openTimeline();
            this._tileOptions = this.childOptions({
                session: this.getOption("session"),
                roomVM: this,
                timeline,
                tileClassForEntry: this._tileClassForEntry,
            });
            this._timelineVM = this.track(new TimelineViewModel(this.childOptions({
                tileOptions: this._tileOptions,
                timeline,
            })));
            this.emitChange("timelineViewModel");
        } catch (error) {
            this.reportError(error);
        }
        this._clearUnreadAfterDelay();
    }

    async _clearUnreadAfterDelay() {
        if (this._room.isArchived || this._clearUnreadTimout) {
            return;
        }
        this._clearUnreadTimout = this.clock.createTimeout(2000);
        try {
            await this._clearUnreadTimout.elapsed();
            await this._room.clearUnread();
            this._clearUnreadTimout = null;
        } catch (err) {
            if (err.name !== "AbortError") {
                throw err;
            }
        }
    }

    focus() {
        this._clearUnreadAfterDelay();
    }

    dispose() {
        super.dispose();
        this._room.off("change", this._onRoomChange);
        if (this._room.isArchived) {
            this._room.release();
        }
        if (this._clearUnreadTimout) {
            this._clearUnreadTimout.abort();
            this._clearUnreadTimout = null;
        }
    }

    // room doesn't tell us yet which fields changed,
    // so emit all fields originating from summary
    _onRoomChange() {
        // propagate the update to the child view models so it's bindings can update based on room changes
        this._composerVM.emitChange();
        this.emitChange();
    }

    get kind() { return "room"; }
    get closeUrl() { return this._closeUrl; }
    get name() { return this._room.name || this.i18n`Empty Room`; }
    get id() { return this._room.id; }
    get timelineViewModel() { return this._timelineVM; }
    get isEncrypted() { return this._room.isEncrypted; }

    get errorViewModel() {
        return this._errorViewModel;
    }

    get avatarLetter() {
        return avatarInitials(this.name);
    }

    get avatarColorNumber() {
        return getIdentifierColorNumber(this._room.avatarColorId)
    }

    avatarUrl(size) {
        return getAvatarHttpUrl(this._room.avatarUrl, size, this.platform, this._room.mediaRepository);
    }

    get avatarTitle() {
        return this.name;
    }

    get canLeave() {
        return this._room.isJoined;
    }

    leaveRoom() {
        this._room.leave();
    }

    get canForget() {
        return this._room.isArchived;
    }

    forgetRoom() {
        this._room.forget();
    }

    get canRejoin() {
        return this._room.isArchived;
    }

    rejoinRoom() {
        this._room.join();
    }

    _createTile(entry) {
        if (this._tileOptions) {
            const Tile = this._tileOptions.tileClassForEntry(entry);
            if (Tile) {
                return new Tile(entry, this._tileOptions);
            }
        }
    }
    
    async _sendMessage(message, replyingTo) {
        if (!this._room.isArchived && message) {
            try {
                let msgtype = "m.text";
                if (message.startsWith("/me ")) {
                    message = message.substr(4).trim();
                    msgtype = "m.emote";
                }
                if (replyingTo) {
                    await replyingTo.reply(msgtype, message);
                } else {
                    await this._room.sendEvent("m.room.message", {msgtype, body: message});
                }
            } catch (error) {
                this.reportError(error);
                return false;
            }
            return true;
        }
        return false;
    }

    async _pickAndSendFile() {
        try {
            const file = await this.platform.openFile();
            if (!file) {
                return;
            }
            return this._sendFile(file);
        } catch (err) {
            console.error(err);
        }
    }

    async _sendFile(file) {
        const content = {
            body: file.name,
            msgtype: "m.file"
        };
        await this._room.sendEvent("m.room.message", content, {
            "url": this._room.createAttachment(file.blob, file.name)
        });
    }

    async _pickAndSendVideo() {
        try {
            if (!this.platform.hasReadPixelPermission()) {
                alert("Please allow canvas image data access, so we can scale your images down.");
                return;
            }
            const file = await this.platform.openFile("video/*");
            if (!file) {
                return;
            }
            if (!file.blob.mimeType.startsWith("video/")) {
                return this._sendFile(file);
            }
            let video;
            try {
                video = await this.platform.loadVideo(file.blob);
            } catch (err) {
                // TODO: extract platform dependent code from view model
                if (err instanceof window.MediaError && err.code === 4) {
                    throw new Error(`this browser does not support videos of type ${file?.blob.mimeType}.`);
                } else {
                    throw err;
                }
            }
            const content = {
                body: file.name,
                msgtype: "m.video",
                info: videoToInfo(video)
            };
            const attachments = {
                "url": this._room.createAttachment(video.blob, file.name),
            };

            const limit = await this.platform.settingsStorage.getInt("sentImageSizeLimit");
            const maxDimension = limit || Math.min(video.maxDimension, 800);
            const thumbnail = await video.scale(maxDimension);
            content.info.thumbnail_info = imageToInfo(thumbnail);
            attachments["info.thumbnail_url"] = 
                this._room.createAttachment(thumbnail.blob, file.name);
            await this._room.sendEvent("m.room.message", content, attachments);
        } catch (error) {
            this.reportError(error);
        }
    }

    async _pickAndSendPicture() {
        try {
            if (!this.platform.hasReadPixelPermission()) {
                alert("Please allow canvas image data access, so we can scale your images down.");
                return;
            }
            const file = await this.platform.openFile("image/*");
            if (!file) {
                return;
            }
            if (!file.blob.mimeType.startsWith("image/")) {
                return this._sendFile(file);
            }
            let image = await this.platform.loadImage(file.blob);
            const limit = await this.platform.settingsStorage.getInt("sentImageSizeLimit");
            if (limit && image.maxDimension > limit) {
                const scaledImage = await image.scale(limit);
                image.dispose();
                image = scaledImage;
            }
            const content = {
                body: file.name,
                msgtype: "m.image",
                info: imageToInfo(image)
            };
            const attachments = {
                "url": this._room.createAttachment(image.blob, file.name),
            };
            if (image.maxDimension > 600) {
                const thumbnail = await image.scale(400);
                content.info.thumbnail_info = imageToInfo(thumbnail);
                attachments["info.thumbnail_url"] = 
                    this._room.createAttachment(thumbnail.blob, file.name);
            }
            await this._room.sendEvent("m.room.message", content, attachments);
        } catch (error) {
            this.reportError(error);
        }
    }

    get room() {
        return this._room;
    }

    get composerViewModel() {
        return this._composerVM;
    }

    get callViewModel() {
        return this._callViewModel;
    }

    openDetailsPanel() {
        let path = this.navigation.path.until("room");
        path = path.with(this.navigation.segment("right-panel", true));
        path = path.with(this.navigation.segment("details", true));
        this.navigation.applyPath(path);
    }

    startReply(entry) {
        if (!this._room.isArchived) {
            this._composerVM.setReplyingTo(entry);
        }
    }

    async startCall() {
        let localMedia;
        try {
            const stream = await this.platform.mediaDevices.getMediaTracks(false, true);
            localMedia = new LocalMedia().withUserMedia(stream);
        } catch (err) {
            this.reportError(new Error(`Could not get local audio and/or video stream: ${err.message}`));
            return;
        }
        const session = this.getOption("session");
        let call;
        try {
            // this will set the callViewModel above as a call will be added to callHandler.calls
            call = await session.callHandler.createCall(this._room.id, "m.video", "A call " + Math.round(this.platform.random() * 100));
        } catch (err) {
            this.reportError(new Error(`Could not create call: ${err.message}`));
            return;
        }
        try {
            await call.join(localMedia);
        } catch (err) {
            this.reportError(new Error(`Could not join call: ${err.message}`));
            return;
        }
    }
}

function videoToInfo(video) {
    const info = imageToInfo(video);
    info.duration = video.duration;
    return info;
}

class ArchivedViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._archivedRoom = options.archivedRoom;
    }

    get description() {
        if (this._archivedRoom.isKicked) {
            if (this._archivedRoom.kickReason) {
                return this.i18n`You were kicked from the room by ${this._archivedRoom.kickedBy.name} because: ${this._archivedRoom.kickReason}`;
            } else {
                return this.i18n`You were kicked from the room by ${this._archivedRoom.kickedBy.name}.`;
            }
        } else if (this._archivedRoom.isBanned) {
            if (this._archivedRoom.kickReason) {
                return this.i18n`You were banned from the room by ${this._archivedRoom.kickedBy.name} because: ${this._archivedRoom.kickReason}`;
            } else {
                return this.i18n`You were banned from the room by ${this._archivedRoom.kickedBy.name}.`;
            }
        } else {
            return this.i18n`You left this room`;
        }
    }

    get kind() {
        return "archived";
    }
}
