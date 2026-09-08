#!/usr/bin/env python3
"""Expose server-backed special activities in the ordinary activity hall."""

import argparse
import importlib.util
import json
import re
import shutil
import struct
from pathlib import Path


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def table(document: dict, name: str) -> dict:
    value = document.get("ed", document)
    return value.get(name, value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-root", type=Path, required=True)
    parser.add_argument("--libsec", type=Path, required=True)
    args = parser.parse_args()

    scripts = Path(__file__).resolve().parent
    decrypt_module = load_module("afk_decrypt", scripts / "decrypt-afk-config.py")
    patch_module = load_module("afk_encrypt", scripts / "patch-private-client-game-util.py")
    decryptor = decrypt_module.AfkDecryptor(args.libsec)
    encryptor = patch_module.AfkEncryptor(decrypt_module, args.libsec)

    for track in ("classic",):
        root = args.assets_root / track / "csvjson" / "en"
        activity_path = root / "Activity.jsone"
        banner_path = root / "ActivityBanner.jsone"
        activity_doc = json.loads(decryptor.decrypt(activity_path.read_bytes()))
        banner_doc = json.loads(decryptor.decrypt(banner_path.read_bytes()))
        activities = table(activity_doc, "ActivityTable")
        banners = table(banner_doc, "ActivityBannerTable")

        activity = activities["2032"]
        activity["IsEnable"] = True
        activity["AreaType"] = "AREA_GATHER|AREA_SIDEBAR"
        for activity_id in (975, 1461):
            hundred_draw = activities[str(activity_id)]
            hundred_draw["IsEnable"] = True
            hundred_draw["AreaType"] = "AREA_GATHER|AREA_SIDEBAR"
        banner = dict(banners.get("1854") or next(iter(banners.values())))
        banner.update({
            "ActivityID": 2032,
            "ArtName": "Unlimited Summons",
            "BannerBG": "res/ui/panel/event/banner_endlessDraws.jpg",
            "SubText": "Keep summoning until you choose the perfect result",
            "IsShow": True,
            "CloseCondition": "",
            "PileUp": "",
            "Type": ["Regular"],
        })
        banners["2032"] = banner

        for target, document in ((activity_path, activity_doc), (banner_path, banner_doc)):
            plain = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            encrypted = encryptor.encrypt(plain)
            target.write_bytes(encrypted)
            verified = json.loads(decryptor.decrypt(encrypted))
            if not verified:
                raise RuntimeError(f"verification failed for {target}")
            print(f"patched {target}")

    # HundredDraw was removed from the HD ActivityConfig shard together with
    # its UI module.  Restore every official Hd* tuning row from the classic
    # shard; the recovered manager expects HdCost/weights/reward pools and
    # otherwise dereferences an undefined array while opening the page.
    classic_activity_config = args.assets_root / "classic" / "srcmodule" / "ActivityConfig.jsone"
    hd_activity_config = args.assets_root / "hd" / "srcmodule" / "ActivityConfig.jsone"
    classic_config_doc = json.loads(
        decryptor.decrypt(classic_activity_config.read_bytes())
    )
    classic_config = table(classic_config_doc, "ActivityConfigTable")
    restored_hd_keys = [key for key in classic_config if key.startswith("Hd")]
    # Do not rewrite the HD shard itself: its project manifest stores the
    # compressed byte length and the native loader truncates a larger file.
    # The rows are projected into the already-loaded table below instead.
    print(f"prepared {len(restored_hd_keys)} HundredDraw runtime config rows")

    # HD CSV shards use a separate container, so inject the same projection in
    # the shared activity manager.  Both classic and HD game_ui_2 scripts use
    # the normal libsec wrapper and can be patched safely.
    for track in ("classic", "hd"):
        target = args.assets_root / track / "srcmodule" / "game_ui_2.jse"
        header, source_bytes = patch_module.extract_wrapper(
            decrypt_module, decryptor, target.read_bytes()
        )
        source = source_bytes.decode("utf-8")
        # Normalize our safe banner anchor back to the template token while
        # matching/replacing an existing patch; it is restored before write.
        safe_banner_template = "x[303]||x[1]||x[Object.keys(x)[0]]||{}"
        source = source.replace(
            f"cc.clone({safe_banner_template})", "cc.clone(x[10115])"
        )
        source = source.replace(
            "cc.clone(x[303]||x[1])", "cc.clone(x[10115])"
        )
        marker = "getAreaActivityIds:function(e){var t=[];"
        legacy_injected = (
            "getAreaActivityIds:function(e){var t=[],x=ed.getDataTable(\"ActivityBanner\");"
            "if(!x[2032]){var z=cc.clone(x[1854]||x[1]);z.ActivityID=2032;"
            "z.ArtName=\"Unlimited Summons\";z.BannerBG=\"res/ui/panel/event/banner_endlessDraws.jpg\";"
            "z.SubText=\"Keep summoning until you choose the perfect result\";"
            "z.IsShow=true;z.CloseCondition=\"\";z.PileUp=\"\";z.Type=[\"Regular\"];x[2032]=z};"
        )
        literal_injected = (
            "getAreaActivityIds:function(e){var t=[],x=ed.getDataTable(\"ActivityBanner\");"
            "if(!x[2032]){var z={ActivityID:2032,ArtName:\"Unlimited Summons\","
            "BannerBG:\"res/ui/panel/event/banner_endlessDraws.jpg\","
            "SubText:\"Keep summoning until you choose the perfect result\",IsShow:true,"
            "CloseCondition:\"\",PileUp:\"\",Type:[\"Regular\"]};x[2032]=z};"
        )
        permanent_template_injected = (
            "getAreaActivityIds:function(e){var t=[],x=ed.getDataTable(\"ActivityBanner\");"
            "if(!x[2032]){var z=x[6]?cc.clone(x[6]):{BannerRes:"
            "\"res/uieditor/event/banners/banner_normal_permanent_login.csb\",SubTextArgs:[],"
            "VideoRes:\"\",SpineRes:[],FcaRes:[],CsbRes:[],BigBannerID:0,GoTo:\"\","
            "UnlockText:\"\",ArtTextConfig:[],AvatarRes:\"\"};z.ActivityID=2032;"
            "z.ArtName=\"Unlimited Summons\";z.IsShow=true;z.CloseCondition=\"\";"
            "z.PileUp=\"\";z.Type=[\"Regular\"];x[2032]=z};"
        )
        injected = (
            "getAreaActivityIds:function(e){var t=[],x=ed.getDataTable(\"ActivityBanner\");"
            "if(!x[2032]){var z=cc.clone(x[10115]);z.ActivityID=2032;"
            "z.ArtName=\"Unlimited Summons\";z.BannerBG=\"res/ui/panel/event/banner_endlessDraws.jpg\";"
            "z.IsShow=true;z.CloseCondition=\"\";z.PileUp=\"\";z.Type=[\"Regular\"];x[2032]=z};"
        )
        if legacy_injected in source:
            source = source.replace(legacy_injected, injected, 1)
        if literal_injected in source:
            source = source.replace(literal_injected, injected, 1)
        if permanent_template_injected in source:
            source = source.replace(permanent_template_injected, injected, 1)
        if injected not in source:
            if marker not in source:
                raise RuntimeError(f"activity manager marker missing in {target}")
            source = source.replace(marker, injected, 1)
        legacy_hundred_banner = (
            'if(!x[1461]){var y=cc.clone(x[10115]);y.ActivityID=1461;'
            'y.ArtName="Gloria Spectacular";y.BannerBG="res/ui/panel/event/banner_hundreddraw2024.jpg";'
            'y.IsShow=true;y.CloseCondition="";y.PileUp="";y.Type=["Regular"];x[1461]=y};'
            'if(!x[975]){var w=cc.clone(x[10115]);w.ActivityID=975;'
            'w.ArtName="Furniture Workshop";w.IsShow=true;w.CloseCondition="";'
            'w.PileUp="";w.Type=["Regular"];x[975]=w};'
        )
        hundred_banner = (
            'var y=cc.clone(x[10115]);y.ActivityID=1461;'
            'y.ArtName="Gloria Spectacular";y.BannerBG="res/ui/panel/event/banner_hundreddraw2024.jpg";'
            'y.IsShow=true;y.CloseCondition="";y.PileUp="";y.Type=["Regular"];x[1461]=y;'
            'var w=cc.clone(x[10115]);w.ActivityID=975;'
            'w.ArtName="Furniture Workshop";w.IsShow=true;w.CloseCondition="";'
            'w.PileUp="";w.Type=["Regular"];x[975]=w;'
        )
        if legacy_hundred_banner in source:
            source = source.replace(legacy_hundred_banner, hundred_banner, 1)
        if hundred_banner not in source:
            banner_anchor = "x[2032]=z};"
            if banner_anchor not in source:
                raise RuntimeError(f"special activity banner anchor missing in {target}")
            source = source.replace(banner_anchor, banner_anchor + hundred_banner, 1)

        # The HD Activity.jsone shard is protected by a delivery-specific
        # container that the classic libsec routine cannot rewrite.  Seed the
        # two official rows before activityModel filters the login payload.
        # Keeping the complete row shape is important: later banner sorting,
        # calendar rendering and code routing all read different fields.
        activity_model_marker = "ed.activityModel={initData:function(e){"
        hundred_config_literal = json.dumps(
            {key: classic_config[key] for key in restored_hd_keys},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        activity_model_injected = (
            'ed.activityModel={initData:function(e){/*PRIVATE_SPECIAL_ACTIVITY_ROWS*/'
            'e=Array.prototype.slice.call(e||[]);'
            'var h=ed.getDataTable("ActivityConfig"),j='
            + hundred_config_literal
            + ';for(var k in j)h[k]=j[k];'
            'var q=ed.getDataTable("Activity"),r={ID:1461,Name:"Gloria Spectacular",'
            'Order:942,Type:"HundredDraw",Code:"code_anni_draw",Params:[],DailyGiftSet:[],'
            'DailyGiftSetLine:[],StrParams:[],ExchangeItemID:0,'
            'AreaType:"AREA_GATHER|AREA_SIDEBAR",OpenCondition:"",Rewards:[],PVPLevelID:0,'
            'SkinType:"",IsEnable:true,IsCalendarEnable:true,Option:"",Trail:"",'
            'BannerShowTime:"",CalendarRes:"res/ui/panel/event/banner_hundreddraw2024.jpg"};'
            'q[1461]=r;q[975]={ID:975,Name:"Furniture Workshop",Order:941,'
            'Type:"HundredDraw",Code:"code_anni_draw",Params:[],DailyGiftSet:[],'
            'DailyGiftSetLine:[],StrParams:[],ExchangeItemID:0,'
            'AreaType:"AREA_GATHER|AREA_SIDEBAR",OpenCondition:"",Rewards:[],PVPLevelID:0,'
            'SkinType:"",IsEnable:true,IsCalendarEnable:true,Option:"",Trail:"",'
            'BannerShowTime:"",CalendarRes:"res/ui/panel/event/banner_hundreddraw.jpg"};'
            'var v=ed.getServerTime(),a=[975,1461];for(var b=0;b<a.length;b++){var c=a[b],d=false;'
            'for(var f=0;f<e.length;f++)if(e[f].id===c){d=true;break}'
            'if(!d)e.push({id:c,type:"hundred_draw",show_time:v-86400,start_time:v-86400,'
            'end_time:v+2419200,delay_time:v+2505600,params:{}})}'
        )
        if "PRIVATE_SPECIAL_ACTIVITY_ROWS" in source:
            source, model_patch_count = re.subn(
                r'ed\.activityModel=\{initData:function\(e\)\{' 
                r'/\*PRIVATE_SPECIAL_ACTIVITY_ROWS\*/.*?'
                r'(?=for\(var t=\{\},i=\[\],n=0;)',
                activity_model_injected,
                source,
                count=1,
            )
            if model_patch_count != 1:
                raise RuntimeError(f"existing activity model injection malformed in {target}")
        else:
            if activity_model_marker not in source:
                raise RuntimeError(f"activity model marker missing in {target}")
            source = source.replace(activity_model_marker, activity_model_injected, 1)
        tail = "return t},getGatherActivityIds:function"
        patched_tail = (
            "if(e===this.area.gather&&t.indexOf(2032)<0&&ed.activityModel.getActivityInfo(2032))"
            "t.push(2032);return t},getGatherActivityIds:function"
        )
        if "t.push(2032)" not in source:
            if tail not in source:
                raise RuntimeError(f"activity manager return marker missing in {target}")
            source = source.replace(tail, patched_tail, 1)
        hundred_tail = (
            "if(e===this.area.gather&&t.indexOf(1461)<0&&ed.activityModel.getActivityInfo(1461))"
            "t.push(1461);if(e===this.area.gather&&t.indexOf(975)<0&&ed.activityModel.getActivityInfo(975))"
            "t.push(975);return t},getGatherActivityIds:function"
        )
        if "t.push(1461)" not in source or "t.push(975)" not in source:
            current_tail = "return t},getGatherActivityIds:function"
            if current_tail not in source:
                raise RuntimeError(f"hundred draw activity return marker missing in {target}")
            source = source.replace(current_tail, hundred_tail, 1)
        diagnostic_append = (
            "if(e===this.area.gather&&t.indexOf(2032)<0&&ed.activityModel.getActivityInfo(2032))t.push(2032);"
            'ed.log("PRIVATE_SPECIAL_ACTIVITY_INFO:"+!!ed.activityModel.getActivityInfo(1461)+":"+!!ed.activityModel.getActivityInfo(975));'
            "if(e===this.area.gather&&t.indexOf(1461)<0&&ed.activityModel.getActivityInfo(1461))t.push(1461);"
            "if(e===this.area.gather&&t.indexOf(975)<0&&ed.activityModel.getActivityInfo(975))t.push(975);"
        )
        activity_append = (
            "if(e===this.area.gather&&t.indexOf(2032)<0&&ed.activityModel.getActivityInfo(2032))t.push(2032);"
            "if(e===this.area.gather&&t.indexOf(1461)<0&&ed.activityModel.getActivityInfo(1461))t.push(1461);"
            "if(e===this.area.gather&&t.indexOf(975)<0&&ed.activityModel.getActivityInfo(975))t.push(975);"
        )
        unconditional_append = (
            "if(e===this.area.gather&&t.indexOf(2032)<0&&ed.activityModel.getActivityInfo(2032))t.push(2032);"
            "if(e===this.area.gather&&t.indexOf(1461)<0)t.push(1461);"
            "if(e===this.area.gather&&t.indexOf(975)<0)t.push(975);"
        )
        source = source.replace(diagnostic_append, activity_append)
        source = source.replace(unconditional_append, activity_append)
        source = re.sub(
            "(?:" + re.escape(activity_append) + "){2,}",
            activity_append,
            source,
            count=1,
        )
        show_marker = "showActivity:function(t,e,i){var n=!0,s=this.staticType._appointed;"
        show_injected = (
            "showActivity:function(t,e,i){if(t===2032){ed.openActivityEndlessDrawPanel(t);return true}"
            "var n=!0,s=this.staticType._appointed;"
        )
        if "openActivityEndlessDrawPanel" not in source:
            if show_marker in source:
                source = source.replace(show_marker, show_injected, 1)
            else:
                structural = re.search(
                    r"(showActivity:function\(([^)]*)\)\{)(?=.{0,160}?staticType\._appointed)",
                    source,
                )
                if not structural:
                    raise RuntimeError(f"activity open marker missing in {target}")
                first_arg = structural.group(2).split(",", 1)[0].strip()
                guard = (
                    f"if({first_arg}===2032){{ed.openActivityEndlessDrawPanel({first_arg});return true}}"
                )
                source = source[: structural.end(1)] + guard + source[structural.end(1) :]
        structural = re.search(r"(showActivity:function\(([^)]*)\)\{)", source)
        if not structural:
            raise RuntimeError(f"hundred draw open marker missing in {target}")
        first_arg = structural.group(2).split(",", 1)[0].strip()
        guard = (
            f'/*PRIVATE_HUNDRED_DRAW_ENTRY*/if({first_arg}===1461){{'
            f'if(ed.anniLuckDrawMgr){{ed.anniLuckDrawMgr.openMainView({first_arg});return true}}}}'
            f'if({first_arg}===975){{if(ed.openHomeland){{ed.openHomeland({{callback:function(){{'
            'ed.fireEvent(ed.homelandEntryEvent.DRAW_FURNITURE)}});return true}}'
        )
        if "PRIVATE_HUNDRED_DRAW_ENTRY" in source:
            source = re.sub(
                r"/\*PRIVATE_HUNDRED_DRAW_ENTRY\*/.*?(?=if\("
                + re.escape(first_arg)
                + r"===2032\))",
                guard,
                source,
                count=1,
            )
        else:
            source = source[: structural.end(1)] + guard + source[structural.end(1) :]
        endless_guard = (
            f"if({first_arg}===2032){{ed.openActivityEndlessDrawPanel({first_arg});return true}}"
        )
        source = re.sub(
            "(?:" + re.escape(endless_guard) + "){2,}", endless_guard, source, count=1
        )
        # ActivityBanner 10115 belongs to a different delivery and is absent
        # from the 1.201 Classic table.  Some HD regional shards also omit 303
        # and 1, so fall back to the first native row before using an empty
        # object.  Cloning undefined crashes the main sidebar before the map
        # can render.
        source = source.replace(
            "cc.clone(x[10115])", f"cc.clone({safe_banner_template})"
        )
        anchored_injected = injected.replace(
            "cc.clone(x[10115])", f"cc.clone({safe_banner_template})"
        )
        patched_source = source.encode("utf-8")
        compressed = patch_module.lz4.block.compress(patched_source, store_size=False)
        wrapped = header + struct.pack("<I", len(patched_source)) + compressed
        encrypted = encryptor.encrypt(wrapped)
        target.write_bytes(encrypted)
        verified = decryptor.decrypt(encrypted).decode("utf-8")
        if (
            anchored_injected not in verified
            or "t.push(2032)" not in verified
            or "t.push(1461)" not in verified
            or "t.push(975)" not in verified
            or "openActivityEndlessDrawPanel" not in verified
            or "PRIVATE_HUNDRED_DRAW_ENTRY" not in verified
            or "PRIVATE_SPECIAL_ACTIVITY_ROWS" not in verified
            or "PRIVATE_SPECIAL_ACTIVITY_INFO" in verified
        ):
            raise RuntimeError(f"script verification failed for {target}")
        print(f"patched {target}")

    # The HD delivery deliberately omits the legacy Homeland and anniversary
    # hundred-draw implementations even though their protocol/config entries
    # remain. Restore those exact, same-version official modules from the
    # classic delivery instead of emulating their UI.
    classic_ui3 = args.assets_root / "classic" / "srcmodule" / "game_ui_3.jse"
    hd_ui3 = args.assets_root / "hd" / "srcmodule" / "game_ui_3.jse"
    _, classic_ui3_bytes = patch_module.extract_wrapper(
        decrypt_module, decryptor, classic_ui3.read_bytes()
    )
    hd_ui3_header, hd_ui3_bytes = patch_module.extract_wrapper(
        decrypt_module, decryptor, hd_ui3.read_bytes()
    )
    classic_source = classic_ui3_bytes.decode("utf-8")
    hd_source = hd_ui3_bytes.decode("utf-8")
    hd_source = hd_source.replace("},;ed.baseCharactor=", "};ed.baseCharactor=", 1)
    if "ed.homelandMainView=" in hd_source and hd_source.rstrip().endswith(","):
        hd_source = hd_source.rstrip()[:-1] + ";"

    def official_slice(start_marker: str, end_marker: str) -> str:
        start = classic_source.find(start_marker)
        end = classic_source.find(end_marker, start + len(start_marker))
        if start < 0 or end < 0:
            raise RuntimeError(f"official module slice missing: {start_marker} -> {end_marker}")
        module_source = classic_source[start:end].rstrip()
        if module_source.endswith(","):
            module_source = module_source[:-1]
        return ";" + module_source + ";"

    if "ed.anniLuckyDrawView=" not in hd_source:
        hd_source += official_slice(
            "ed.anniLuckyDrawView=", "ed.activityAnni2023WarmUpView="
        )
    if "ed.homelandMainView=" not in hd_source:
        hd_source += official_slice("ed.baseCharactor=", "ed.tag_change_prob_kr=")

    # Current HD game_util removed the furniture value object together with
    # the old Homeland views. Restore the official implementation (including
    # furnitureSkinData) so rewards can be materialized before draw panels
    # inspect quality/type/getInfo.
    if "ed.furnitureData=" not in hd_source:
        classic_util = args.assets_root / "classic" / "srcmodule" / "game_util.jse"
        _, classic_util_bytes = patch_module.extract_wrapper(
            decrypt_module, decryptor, classic_util.read_bytes()
        )
        classic_util_source = classic_util_bytes.decode("utf-8")
        furniture_start = classic_util_source.find("ed.furnitureData=")
        furniture_end = classic_util_source.find("ed.mitamaData=", furniture_start)
        if furniture_start < 0 or furniture_end < 0:
            raise RuntimeError("official furnitureData slice missing")
        furniture_source = classic_util_source[furniture_start:furniture_end].rstrip()
        if furniture_source.endswith(","):
            furniture_source = furniture_source[:-1]
        hd_source += ";" + furniture_source + ";"

    # The legacy Homeland views store furniture on ed.player, whereas the
    # current client moved the bag into homelandModel.  Bridge the public
    # methods used by the recovered views and tolerate controls which were
    # intentionally removed from the newer HD layouts.
    homeland_compat_marker = "PRIVATE_HOMELAND_COMPAT_V2"
    if homeland_compat_marker not in hd_source:
        hd_source += (
            ';/*PRIVATE_HOMELAND_COMPAT_V2*/(function(){var p=ed.player,m=ed.homelandModel;'
            'if(!p||!m)return;'
            'p.getAllFurnitureUniq=p.getAllFurnitureUniq||function(){return m.getAllFurnitureUniq?m.getAllFurnitureUniq():[]};'
            'p.getFurniture=p.getFurniture||function(e){return m.getFurniture?m.getFurniture(e):null};'
            'p.getAllFurnitureSkin=p.getAllFurnitureSkin||function(){return[]};'
            'p.haveFurnitureSkin=p.haveFurnitureSkin||function(){return!1};'
            'p.initFurniture=p.initFurniture||function(e){m.initFurniture&&m.initFurniture("__bag__",e||[])};'
            'p.initFurnitureSkin=p.initFurnitureSkin||function(){};'
            'p.addFurniture=function(e){if(!e)return;var f=m.getFurniture&&m.getFurniture(e.id);'
            'if(f)f.setData(e);else if(ed.furnitureData){f=ed.furnitureData.create(e);'
            'm._furnitures_order=m._furnitures_order||[];m._furnitures_qunty=m._furnitures_qunty||{};'
            'm._furnitures_roomId=m._furnitures_roomId||{};m._furnitures_order.push(f.id);'
            'm._furnitures_qunty[f.id]=f;m._furnitures_roomId[f.id]="__bag__"}}'
            '})();'
        )

    old_tavern_guide = (
        '-1!==ed.homelandTavernWishModel.getEmptySlot()&&'
        'ed.guideMgr.isTutorialFinished("HomelandDraw")?this.tavernGuideFinger||'
    )
    new_tavern_guide = (
        '-1!==ed.homelandTavernWishModel.getEmptySlot()&&'
        'ed.guideMgr.isTutorialFinished("HomelandDraw")&&e.getComponent("btn_up_hero")?'
        'this.tavernGuideFinger||'
    )
    hd_source = hd_source.replace(old_tavern_guide, new_tavern_guide)

    old_jade_refresh = (
        'refreshJadeUI:function(){var e=this.ui_editor,t=ed.player.getItemAmount(this.itemId);'
        'e.getComponent("text_jade_card_count").setString(t);'
    )
    new_jade_refresh = (
        'refreshJadeUI:function(){var e=this.ui_editor,t=ed.player.getItemAmount(this.itemId),'
        'r=e.getComponent("text_jade_card_count");if(!r)return;r.setString(t);'
    )
    hd_source = hd_source.replace(old_jade_refresh, new_jade_refresh)
    old_jade_touch = (
        'addTouchEvent:function(){var e=this.ui_editor,t=this,e=e.getComponent("btn_jade_bar");'
        'e.setTouchEnabled(!0),'
    )
    new_jade_touch = (
        'addTouchEvent:function(){var e=this.ui_editor,t=this,e=e.getComponent("btn_jade_bar");'
        'if(!e)return;e.setTouchEnabled(!0),'
    )
    hd_source = hd_source.replace(old_jade_touch, new_jade_touch)
    old_ten_draw_lookup = 'var o=ed.player.getFurniture(t[n].id);this.furnitures.push(o),9===o.quality'
    new_ten_draw_lookup = (
        'var o=ed.player.getFurniture(t[n].id)||ed.furnitureData.create(t[n]);'
        'this.furnitures.push(o),9===o.quality'
    )
    hd_source = hd_source.replace(old_ten_draw_lookup, new_ten_draw_lookup)
    if (
        homeland_compat_marker not in hd_source
        or new_tavern_guide not in hd_source
        or new_jade_refresh not in hd_source
        or new_jade_touch not in hd_source
        or new_ten_draw_lookup not in hd_source
    ):
        raise RuntimeError("Homeland HD compatibility patch failed")

    # The current HD protocol bundle no longer declares req_hundred_draw even
    # though the official legacy page still calls it.  Keep the recovered UI
    # operational with the same client reward/cost objects used by the normal
    # reply handler.  This also avoids crashing the network queue before the
    # user can inspect the pool and task subpages.
    original_req_log = (
        'reqLog:function(e){ed.rpc.send("req_hundred_draw",{open_panel:{}},function(e){'
        'e=e.reply_hundred_draw.histories||[];ed.anniLuckDrawMgr.setLuckyLogData(e),'
        'ed.fireEvent("EVENT_ANNI_LUCKY_DRAW_LOG")})}'
    )
    local_req_log = (
        'reqLog:function(e){this.setLuckyLogData([]),'
        'ed.fireEvent("EVENT_ANNI_LUCKY_DRAW_LOG")}'
    )
    hd_source = hd_source.replace(original_req_log, local_req_log)
    original_req_draw = (
        'reqDraw:function(e,t){e<1||this.checkCanDraw(e)&&ed.rpc.send("req_hundred_draw",'
        '{req_draw:e},function(e){var t=e.reply_hundred_draw.histories||[],t='
        '(ed.anniLuckDrawMgr.setLuckyLogData(t),e.reply_hundred_draw.draw_res),e='
        'e.reply_hundred_draw.draw_res.reward;ed.player.addReward(e),t.cost&&'
        'ed.player.consumption(t.cost),ed.fireEvent("EVENT_ANNI_LUCKY_DRAW_RES",t)})}'
    )
    local_req_draw = (
        'reqDraw:function(e,t){if(e<1||!this.checkCanDraw(e))return;var i={assets:[]};'
        'for(var n=0;n<e;n++)i.assets.push({type:"item",id:13,amount:1});'
        'var o={reward:i,cost:{type:"item",id:550,amount:e}};ed.player.addReward(i),'
        'ed.player.consumption(o.cost),ed.fireEvent("EVENT_ANNI_LUCKY_DRAW_RES",o)}'
    )
    hd_source = hd_source.replace(original_req_draw, local_req_draw)
    original_task_data = (
        'req_task_data:function(e,t){e&&!ed.activityDataMgr.getInstance().isActvityInValid(e)'
        '&&ed.rpc.send("req_activity",{act_task_open_panel:e},function(e){'
        't&&t(e.reply_activity.act_task_open_panel.task)})}'
    )
    local_task_data = (
        'req_task_data:function(e,t){e&&t&&t({tasks:[]})}'
    )
    hd_source = hd_source.replace(original_task_data, local_task_data)
    if (
        'reqLog:function(e){this.setLuckyLogData([])' not in hd_source
        or 'reqDraw:function(e,t){if(e<1||!this.checkCanDraw(e))return' not in hd_source
    ):
        raise RuntimeError("HundredDraw HD protocol compatibility patch failed")
    patched_ui3 = hd_source.encode("utf-8")
    compressed_ui3 = patch_module.lz4.block.compress(patched_ui3, store_size=False)
    encrypted_ui3 = encryptor.encrypt(
        hd_ui3_header + struct.pack("<I", len(patched_ui3)) + compressed_ui3
    )
    hd_ui3.write_bytes(encrypted_ui3)
    _, verified_ui3 = patch_module.extract_wrapper(
        decrypt_module, decryptor, encrypted_ui3
    )
    verified_ui3_source = verified_ui3.decode("utf-8")
    if "ed.anniLuckyDrawView=" not in verified_ui3_source or "ed.homelandMainView=" not in verified_ui3_source:
        raise RuntimeError("restored HD activity modules failed verification")
    print(f"restored official activity modules in {hd_ui3}")

    # The code above references CSB layouts intentionally absent from HD.
    # Overlay only the two matching official UI directories and three rule
    # tables; other HD assets remain untouched.
    classic_res = args.assets_root / "classic" / "res" / "uieditor"
    hd_res = args.assets_root / "hd" / "res" / "uieditor"
    for relative in (Path("homeland"), Path("event/activityhundeddraws")):
        source_dir = classic_res / relative
        target_dir = hd_res / relative
        for source_file in source_dir.rglob("*"):
            if not source_file.is_file():
                continue
            target_file = target_dir / source_file.relative_to(source_dir)
            target_file.parent.mkdir(parents=True, exist_ok=True)
            # Keep every native HD layout.  Classic assets only fill files
            # absent from the current delivery.
            if not target_file.exists():
                shutil.copy2(source_file, target_file)
    classic_rules = args.assets_root / "classic" / "csvjson" / "en" / "Rule"
    hd_rules = args.assets_root / "hd" / "csvjson" / "en" / "Rule"
    hd_rules.mkdir(parents=True, exist_ok=True)
    for rule in (
        "Rule_s_HomelandAutoEquip.jsone",
        "Rule_s_HomelandAutoFurniture.jsone",
        "Rule_s_HomelandTavern.jsone",
    ):
        shutil.copy2(classic_rules / rule, hd_rules / rule)
    print("restored official Homeland and HundredDraw UI assets")

    # The 1.201 client still hard-codes only the legacy tavern tickets (13/14)
    # in the ordinary banner widget. New SP/Draconis pools use item IDs such as
    # 2044, 6000 and 6001, so resolve every other item icon through Item.UIIcon.
    for track in ("classic", "hd"):
        target = args.assets_root / track / "srcmodule" / "game_ui_1.jse"
        header, source_bytes = patch_module.extract_wrapper(
            decrypt_module, decryptor, target.read_bytes()
        )
        source = source_bytes.decode("utf-8")
        legacy = (
            '"item"===t.toLowerCase()&&(13==i?a={root:ed.createSprite('
            '"res/ui/panel/bag/n_classic_pack_ticket.png")}:14==i&&(a={root:ed.createSprite('
            '"res/ui/panel/bag/n_special_pack_ticket.png")})),a}'
        )
        fixed_plain = (
            '"item"===t.toLowerCase()&&(13==i?a={root:ed.createSprite('
            '"res/ui/panel/bag/n_classic_pack_ticket.png")}:14==i?a={root:ed.createSprite('
            '"res/ui/panel/bag/n_special_pack_ticket.png")}:a={root:ed.createSprite('
            'ed.lookupDataTable("Item","UIIcon",i))}),a}'
        )
        fixed = fixed_plain.replace(
            'ed.lookupDataTable("Item","UIIcon",i)',
            '(ed.getDataTable("Item")[i]||(ed.getDataTable("Item")[i]=cc.clone(ed.getDataTable("Item")[13]),ed.getDataTable("Item")[i].ID=i),ed.lookupDataTable("Item","UIIcon",i))',
        )
        legacy_classic = (
            '"item"===t.toLowerCase()&&(13==e?i={root:ed.createSprite('
            '"res/ui/panel/bag/n_classic_pack_ticket.png")}:14==e&&(i={root:ed.createSprite('
            '"res/ui/panel/bag/n_special_pack_ticket.png")})),i}'
        )
        fixed_classic_plain = (
            '"item"===t.toLowerCase()&&(13==e?i={root:ed.createSprite('
            '"res/ui/panel/bag/n_classic_pack_ticket.png")}:14==e?i={root:ed.createSprite('
            '"res/ui/panel/bag/n_special_pack_ticket.png")}:i={root:ed.createSprite('
            'ed.lookupDataTable("Item","UIIcon",e))}),i}'
        )
        fixed_classic = fixed_classic_plain.replace(
            'ed.lookupDataTable("Item","UIIcon",e)',
            '(ed.getDataTable("Item")[e]||(ed.getDataTable("Item")[e]=cc.clone(ed.getDataTable("Item")[13]),ed.getDataTable("Item")[e].ID=e),ed.lookupDataTable("Item","UIIcon",e))',
        )
        if legacy in source:
            source = source.replace(legacy, fixed)
        if fixed_plain in source:
            source = source.replace(fixed_plain, fixed)
        if legacy_classic in source:
            source = source.replace(legacy_classic, fixed_classic)
        if fixed_classic_plain in source:
            source = source.replace(fixed_classic_plain, fixed_classic)
        # Emit the selected pool ID into logcat. This is intentionally kept in
        # release builds as a low-volume support diagnostic for device tests.
        if "PRIVATE_TAVERN_POOL_ID:" not in source:
            source = re.sub(
                r'([A-Za-z_$][\w$]*)=this\.bigBanner\.data;',
                r'\1=this.bigBanner.data;ed.log("PRIVATE_TAVERN_POOL_ID:"+\1.id);',
                source,
                count=1,
            )
        if fixed not in source and fixed_classic not in source:
            raise RuntimeError(f"tavern item icon marker missing in {target}")
        patched_source = source.encode("utf-8")
        if header:
            compressed = patch_module.lz4.block.compress(patched_source, store_size=False)
            wrapped = header + struct.pack("<I", len(patched_source)) + compressed
        else:
            wrapped = patched_source
        encrypted = encryptor.encrypt(wrapped)
        target.write_bytes(encrypted)
        _, verified_bytes = patch_module.extract_wrapper(
            decrypt_module, decryptor, encrypted
        )
        verified_source = verified_bytes.decode("utf-8")
        if fixed not in verified_source and fixed_classic not in verified_source:
            raise RuntimeError(f"tavern item icon verification failed for {target}")
        print(f"patched {target}")

    # The HD delivery has per-hero SignatureLevel caps of 30/40 while the
    # Classic delivery contains 30/40/50 rows. A shared account may therefore
    # legitimately carry a level that is newer than the selected delivery's
    # local icon table. Fall back to that delivery's highest available icon
    # row instead of aborting the entire hero detail page.
    signature_icon_lookup = (
        'ed.getDataTable("SignatureLevel")[this._tid][this.signature_lv].EquipIcon'
    )
    signature_icon_safe_lookup = (
        '(ed.getDataTable("SignatureLevel")[this._tid][this.signature_lv]||'
        'ed.getDataTable("SignatureLevel")[this._tid][Math.max.apply(Math,'
        'Object.keys(ed.getDataTable("SignatureLevel")[this._tid]))]).EquipIcon'
    )
    for track in ("classic", "hd"):
        target = args.assets_root / track / "srcmodule" / "game_base.jse"
        header, source_bytes = patch_module.extract_wrapper(
            decrypt_module, decryptor, target.read_bytes()
        )
        source = source_bytes.decode("utf-8")
        # Make this patch idempotent so rebuilt release candidates can reuse
        # an already-patched decoded tree.
        if signature_icon_safe_lookup not in source:
            occurrences = source.count(signature_icon_lookup)
            if occurrences < 1:
                raise RuntimeError(f"signature icon marker missing in {target}")
            source = source.replace(signature_icon_lookup, signature_icon_safe_lookup)
        patched_source = source.encode("utf-8")
        if header:
            compressed = patch_module.lz4.block.compress(patched_source, store_size=False)
            wrapped = header + struct.pack("<I", len(patched_source)) + compressed
        else:
            wrapped = patched_source
        encrypted = encryptor.encrypt(wrapped)
        target.write_bytes(encrypted)
        _, verified_bytes = patch_module.extract_wrapper(
            decrypt_module, decryptor, encrypted
        )
        if signature_icon_safe_lookup not in verified_bytes.decode("utf-8"):
            raise RuntimeError(f"signature icon verification failed for {target}")
        print(f"patched {target}")


if __name__ == "__main__":
    main()
