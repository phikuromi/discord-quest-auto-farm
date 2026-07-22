delete window.$;

(async function () {
    const logger = {
        info: (...args) => console.log("%c[QuestAutoFarm]%c", "color: #5865F2; font-weight: bold;", "", ...args),
        success: (...args) => console.log("%c[QuestAutoFarm]%c", "color: #43B581; font-weight: bold;", "", ...args),
        warn: (...args) => console.warn("%c[QuestAutoFarm]%c", "color: #FAA61A; font-weight: bold;", "", ...args),
        error: (...args) => console.error("%c[QuestAutoFarm]%c", "color: #F04747; font-weight: bold;", "", ...args)
    };

    logger.info("Initializing script...");

    let wpRequire;
    if (window.webpackChunkdiscord_app) {
        wpRequire = window.webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
        window.webpackChunkdiscord_app.pop();
    } else {
        return logger.error("Critical error: webpackChunkdiscord_app not found.");
    }

    const findModule = (filter) => {
        for (const key in wpRequire.c) {
            const mod = wpRequire.c[key];
            if (!mod?.exports) continue;
            for (const prop in mod.exports) {
                const target = mod.exports[prop];
                if (target && (typeof target === 'object' || typeof target === 'function') && filter(target)) {
                    return target;
                }
            }
            if (filter(mod.exports)) return mod.exports;
        }
        return null;
    };

    const ApplicationStreamingStore = findModule(m => m.getStreamerActiveStreamMetadata);
    const RunningGameStore = findModule(m => m.getRunningGames && m.getGameForPID);
    const QuestsStore = findModule(m => m.getQuest && m.quests);
    const ChannelStore = findModule(m => m.getAllThreadsForParent);
    const GuildChannelStore = findModule(m => m.getSFWDefaultChannel);
    const FluxDispatcher = findModule(m => m.flushWaitQueue && m.dispatch);
    
    // Precise search for the original Discord client API (Bo)
    let api = Object.values(wpRequire.c).find(x => x?.exports?.Bo?.get)?.exports?.Bo;
    if (!api) {
        api = findModule(m => m && typeof m.get === 'function' && typeof m.post === 'function');
    }

    if (!QuestsStore || !api || !FluxDispatcher) {
        return logger.error("Failed to find critical modules (QuestsStore, api, or FluxDispatcher).");
    }

    const SUPPORTED_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];
    const isApp = typeof DiscordNative !== "undefined";

    const quests = [...QuestsStore.quests.values()].filter(x => 
        x.userStatus?.enrolledAt && 
        !x.userStatus?.completedAt && 
        new Date(x.config.expiresAt).getTime() > Date.now() && 
        SUPPORTED_TASKS.some(y => Object.keys((x.config.taskConfig ?? x.config.taskConfigV2).tasks).includes(y))
    );

    if (quests.length === 0) {
        return logger.info("No available or unfinished quests found!");
    }

    logger.info(`Found quests to complete: ${quests.length}`);

    const handlers = {
        async handleVideo(quest, secondsNeeded, secondsDone) {
            const maxFuture = 10, speed = 7, interval = 1;
            const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
            let completed = false;
            
            logger.info(`Starting video watch progress simulation for: ${quest.config.messages.questName}`);
            
            while (!completed && secondsDone < secondsNeeded) {
                const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
                const diff = maxAllowed - secondsDone;
                const timestamp = secondsDone + speed;
                
                if (diff >= speed) {
                    try {
                        const res = await api.post({
                            url: `/quests/${quest.id}/video-progress`, 
                            body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }
                        });
                        completed = res.body.completed_at != null;
                        secondsDone = Math.min(secondsNeeded, timestamp);
                    } catch (e) {
                        logger.error("Network failure while updating video progress", e);
                        break;
                    }
                }
                if (timestamp >= secondsNeeded) break;
                await new Promise(r => setTimeout(r, interval * 1000));
            }

            if (!completed) {
                try {
                    await api.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
                } catch(e) {}
            }
        },

        async handleDesktopPlay(quest, applicationId, applicationName, secondsNeeded, secondsDone) {
            if (!isApp) {
                return logger.warn(`Quest ${quest.config.messages.questName} must be completed via the desktop application.`);
            }

            logger.info(`Emulating game activity for ${applicationName}... Please wait ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min.`);

            try {
                const res = await api.get({ url: `/applications/public?application_ids=${applicationId}` });
                const appData = res.body[0];
                const exeName = appData.executables?.find(x => x.os === "win32")?.name?.replace(">", "") ?? appData.name.replace(/[\/\\:*?"<>|]/g, "");
                const pid = Math.floor(Math.random() * 30000) + 1000;

                const fakeGame = {
                    cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
                    exeName,
                    exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
                    hidden: false,
                    isLauncher: false,
                    id: applicationId,
                    name: appData.name,
                    pid,
                    pidPath: [pid],
                    processName: appData.name,
                    start: Date.now(),
                };

                const realGetRunningGames = RunningGameStore.getRunningGames;
                const realGetGameForPID = RunningGameStore.getGameForPID;
                const realGames = realGetRunningGames();
                
                RunningGameStore.getRunningGames = () => [fakeGame];
                RunningGameStore.getGameForPID = (p) => p === pid ? fakeGame : undefined;
                FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] });

                return new Promise(resolve => {
                    const fn = (data) => {
                        const progress = quest.config.configVersion === 1 
                            ? data.userStatus.streamProgressSeconds 
                            : Math.floor(data.userStatus.progress.PLAY_ON_DESKTOP.value);
                    
                        logger.info(`Progress [GAME]: ${progress}/${secondsNeeded} sec.`);
                    
                        if (progress >= secondsNeeded) {
                            RunningGameStore.getRunningGames = realGetRunningGames;
                            RunningGameStore.getGameForPID = realGetGameForPID;
                            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
                            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                            resolve();
                        }
                    };
                    FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                });
            } catch (e) {
                logger.error("Failed to fetch application data via API", e);
            }
        },

        async handleDesktopStream(quest, applicationId, applicationName, secondsNeeded, secondsDone) {
            if (!isApp) {
                return logger.warn(`Quest ${quest.config.messages.questName} must be completed via the desktop application.`);
            }

            logger.info(`Emulating stream for ${applicationName}... Please wait ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min.`);
            logger.warn("IMPORTANT: Join any voice channel with at least 1 viewer and start streaming any window!");

            const pid = Math.floor(Math.random() * 30000) + 1000;
            const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
            
            ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
                id: applicationId,
                pid,
                sourceName: null
            });

            return new Promise(resolve => {
                const fn = (data) => {
                    const progress = quest.config.configVersion === 1 
                        ? data.userStatus.streamProgressSeconds 
                        : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);
                
                    logger.info(`Progress [STREAM]: ${progress}/${secondsNeeded} sec.`);
                
                    if (progress >= secondsNeeded) {
                        ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
                        FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                        resolve();
                    }
                };
                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
            });
        },

        async handleActivity(quest, secondsNeeded) {
            logger.info(`Farming activity for: ${quest.config.messages.questName}`);
            
            const pChannels = ChannelStore.getSortedPrivateChannels?.() || [];
            const guilds = GuildChannelStore.getAllGuilds?.() || {};
            const channelId = pChannels[0]?.id ?? Object.values(guilds).find(x => x && x.VOCAL?.length > 0)?.VOCAL[0]?.channel?.id;
            
            if (!channelId) {
                return logger.error("Failed to find a suitable voice channel for activity emulation.");
            }

            const streamKey = `call:${channelId}:1`;

            while (true) {
                try {
                    const res = await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: false } });
                    const progress = res.body.progress.PLAY_ACTIVITY.value;
                    logger.info(`Progress [ACTIVITY]: ${progress}/${secondsNeeded} sec.`);

                    if (progress >= secondsNeeded) {
                        await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } });
                        break;
                    }
                } catch (e) {
                    logger.error("Error sending activity heartbeat", e);
                }
                await new Promise(r => setTimeout(r, 20 * 1000));
            }
        }
    };

    for (const quest of quests) {
        const applicationId = quest.config.application.id;
        const applicationName = quest.config.application.name;
        const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
        const taskName = SUPPORTED_TASKS.find(x => taskConfig.tasks[x] != null);
        
        if (!taskName) continue;

        const secondsNeeded = taskConfig.tasks[taskName].target;
        const secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

        try {
            switch (taskName) {
                case "WATCH_VIDEO":
                case "WATCH_VIDEO_ON_MOBILE":
                    await handlers.handleVideo(quest, secondsNeeded, secondsDone);
                    break;
                case "PLAY_ON_DESKTOP":
                    await handlers.handleDesktopPlay(quest, applicationId, applicationName, secondsNeeded, secondsDone);
                    break;
                case "STREAM_ON_DESKTOP":
                    await handlers.handleDesktopStream(quest, applicationId, applicationName, secondsNeeded, secondsDone);
                    break;
                case "PLAY_ACTIVITY":
                    await handlers.handleActivity(quest, secondsNeeded);
                    break;
            }
            logger.success(`Quest "${quest.config.messages.questName}" successfully completed!`);
        } catch (error) {
            logger.error(`Failed to execute quest "${quest.config.messages.questName}":`, error);
        }
    }
    
    logger.success("All available quests processed!");
})();
