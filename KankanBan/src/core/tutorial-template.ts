import type {TutorialCardTemplate} from './tutorial-schema.ts';
import {AVAILABLE_EXTENSIONS} from '../extensions/registry.ts';

// Structure only: localized prose lives in i18n/zh-CN.json.
const coreCards:readonly TutorialCardTemplate[] = [
  {
    "key": "root",
    "parent": null,
    "title": "tutorial.rootTitle",
    "content": "tutorial.rootBody",
    "role": "root"
  },
  {
    "key": "faceA",
    "parent": "root",
    "title": "tutorial.faceATitle",
    "content": "tutorial.faceABody",
    "role": "face"
  },
  {
    "key": "a1",
    "parent": "faceA",
    "title": "tutorial.a1Title",
    "content": "tutorial.a1Body",
    "role": "level",
    "level": "a1"
  },
  {
    "key": "a1_windows",
    "parent": "a1",
    "title": "tutorial.a1_windowsTitle",
    "content": "tutorial.a1_windowsBody",
    "role": "step",
    "level": "a1"
  },
  {
    "key": "a1_trash",
    "parent": "a1_windows",
    "title": "tutorial.a1_trashTitle",
    "content": "tutorial.a1_trashBody",
    "role": "practice",
    "level": "a1"
  },
  {
    "key": "a2",
    "parent": "faceA",
    "title": "tutorial.a2Title",
    "content": "tutorial.a2Body",
    "role": "level",
    "level": "a2"
  },
  {
    "key": "a2_headings",
    "parent": "a2",
    "title": "tutorial.a2_headingsTitle",
    "content": "tutorial.a2_headingsBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a2_emphasis",
    "parent": "a2",
    "title": "tutorial.a2_emphasisTitle",
    "content": "tutorial.a2_emphasisBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a2_lists",
    "parent": "a2",
    "title": "tutorial.a2_listsTitle",
    "content": "tutorial.a2_listsBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a2_tasks",
    "parent": "a2",
    "title": "tutorial.a2_tasksTitle",
    "content": "tutorial.a2_tasksBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a2_quote",
    "parent": "a2",
    "title": "tutorial.a2_quoteTitle",
    "content": "tutorial.a2_quoteBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a2_link",
    "parent": "a2",
    "title": "tutorial.a2_linkTitle",
    "content": "tutorial.a2_linkBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a2_code",
    "parent": "a2",
    "title": "tutorial.a2_codeTitle",
    "content": "tutorial.a2_codeBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a2_rule",
    "parent": "a2",
    "title": "tutorial.a2_ruleTitle",
    "content": "tutorial.a2_ruleBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a2_scripts",
    "parent": "a2",
    "title": "tutorial.a2_scriptsTitle",
    "content": "tutorial.a2_scriptsBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a2_escape",
    "parent": "a2",
    "title": "tutorial.a2_escapeTitle",
    "content": "tutorial.a2_escapeBody",
    "role": "step",
    "level": "a2"
  },
  {
    "key": "a3",
    "parent": "faceA",
    "title": "tutorial.a3Title",
    "content": "tutorial.a3Body",
    "role": "level",
    "level": "a3",
    "layout": "ordered",
    "images": [
      {
        "asset": "star",
        "layout": "inline",
        "width": 240,
        "height": 240
      }
    ],
    "doodleAsset": "a3"
  },
  {
    "key": "a4",
    "parent": "faceA",
    "title": "tutorial.a4Title",
    "content": "tutorial.a4Body",
    "role": "level",
    "level": "a4",
    "layout": "ordered"
  },
  {
    "key": "a4_target",
    "parent": "a4",
    "title": "tutorial.a4_targetTitle",
    "content": "tutorial.a4_targetBody",
    "role": "step",
    "level": "a4"
  },
  {
    "key": "a4_reference",
    "parent": "a4_target",
    "title": "tutorial.a4_referenceTitle",
    "content": "tutorial.a4_referenceBody",
    "role": "practice",
    "level": "a4"
  },
  {
    "key": "a4_move",
    "parent": "a4",
    "title": "tutorial.a4_moveTitle",
    "content": "tutorial.a4_moveBody",
    "role": "practice",
    "level": "a4"
  },
  {
    "key": "a4_sync",
    "parent": "a4_move",
    "title": "tutorial.a4_syncTitle",
    "content": "tutorial.a4_syncBody",
    "role": "step",
    "level": "a4"
  },
  {
    "key": "a4_delete",
    "parent": "a4_move",
    "title": "tutorial.a4_deleteTitle",
    "content": "tutorial.a4_deleteBody",
    "role": "step",
    "level": "a4"
  },
  {
    "key": "a5",
    "parent": "faceA",
    "title": "tutorial.a5Title",
    "content": "tutorial.a5Body",
    "role": "level",
    "level": "a5"
  },
  {
    "key": "a5_board",
    "parent": "a5",
    "title": "tutorial.a5_boardTitle",
    "content": "tutorial.a5_boardBody",
    "role": "practice",
    "level": "a5",
    "layout": "columns"
  },
  {
    "key": "a5_todo",
    "parent": "a5_board",
    "title": "tutorial.a5_todoTitle",
    "content": "tutorial.a5_todoBody",
    "role": "practice",
    "level": "a5",
    "layout": "ordered"
  },
  {
    "key": "a5_taskA",
    "parent": "a5_todo",
    "title": "tutorial.a5_taskATitle",
    "content": "tutorial.a5_taskABody",
    "role": "practice",
    "level": "a5"
  },
  {
    "key": "a5_taskB",
    "parent": "a5_todo",
    "title": "tutorial.a5_taskBTitle",
    "content": "tutorial.a5_taskBBody",
    "role": "practice",
    "level": "a5"
  },
  {
    "key": "a5_taskC",
    "parent": "a5_todo",
    "title": "tutorial.a5_taskCTitle",
    "content": "tutorial.a5_taskCBody",
    "role": "practice",
    "level": "a5"
  },
  {
    "key": "a5_taskD",
    "parent": "a5_todo",
    "title": "tutorial.a5_taskDTitle",
    "content": "tutorial.a5_taskDBody",
    "role": "practice",
    "level": "a5"
  },
  {
    "key": "a5_agile",
    "parent": "a5_todo",
    "title": "tutorial.a5_agileTitle",
    "content": "tutorial.a5_agileBody",
    "role": "practice",
    "level": "a5"
  },
  {
    "key": "a5_doing",
    "parent": "a5_board",
    "title": "tutorial.a5_doingTitle",
    "content": "tutorial.a5_doingBody",
    "role": "practice",
    "level": "a5",
    "layout": "ordered"
  },
  {
    "key": "a5_done",
    "parent": "a5_board",
    "title": "tutorial.a5_doneTitle",
    "content": "tutorial.a5_doneBody",
    "role": "practice",
    "level": "a5",
    "layout": "ordered"
  },
  {
    "key": "authored_1",
    "parent": "a5_done",
    "title": "tutorial.authored_1Title",
    "content": "tutorial.authored_1Body",
    "role": "practice",
    "level": "a5"
  },
  {
    "key": "a6",
    "parent": "faceA",
    "title": "tutorial.a6Title",
    "content": "tutorial.a6Body",
    "role": "level",
    "level": "a6",
    "layout": "plane",
    "doodleAsset": "a6"
  },
  {
    "key": "a6_start",
    "parent": "a6",
    "title": "tutorial.a6_startTitle",
    "content": "tutorial.a6_startBody",
    "role": "step",
    "level": "a6",
    "plane": {
      "x": 220.91605068825493,
      "y": 134.9186855055773,
      "w": 240,
      "h": 160,
      "z": 0
    }
  },
  {
    "key": "a6_near",
    "parent": "a6",
    "title": "tutorial.a6_nearTitle",
    "content": "tutorial.a6_nearBody",
    "role": "step",
    "level": "a6",
    "plane": {
      "x": 213.00882579960353,
      "y": 1048.1693723325302,
      "w": 240,
      "h": 160,
      "z": 1
    }
  },
  {
    "key": "a6_middle",
    "parent": "a6",
    "title": "tutorial.a6_middleTitle",
    "content": "tutorial.a6_middleBody",
    "role": "step",
    "level": "a6",
    "plane": {
      "x": 1445.6305819060858,
      "y": 1048.1639184321689,
      "w": 240,
      "h": 160,
      "z": 2
    }
  },
  {
    "key": "a6_far",
    "parent": "a6",
    "title": "tutorial.a6_farTitle",
    "content": "tutorial.a6_farBody",
    "role": "step",
    "level": "a6",
    "plane": {
      "x": 1462.9928082338347,
      "y": 9.282550943197293,
      "w": 240,
      "h": 160,
      "z": 3
    }
  },
  {
    "key": "a7",
    "parent": "faceA",
    "title": "tutorial.a7Title",
    "content": "tutorial.a7Body",
    "role": "level",
    "level": "a7",
    "prefabRef": "a7_template",
    "prefabBaseContent": "tutorial.a7_baselineBody"
  },
  {
    "key": "a7_create",
    "parent": "a7",
    "title": "tutorial.a7_createTitle",
    "content": "tutorial.a7_createBody",
    "role": "step",
    "level": "a7",
    "prefabRef": "a7_template_create"
  },
  {
    "key": "a7_instantiate",
    "parent": "a7",
    "title": "tutorial.a7_instantiateTitle",
    "content": "tutorial.a7_instantiateBody",
    "role": "step",
    "level": "a7",
    "prefabRef": "a7_template_instantiate"
  },
  {
    "key": "a7_move",
    "parent": "a7",
    "title": "tutorial.a7_moveTitle",
    "content": "tutorial.a7_moveBody",
    "role": "step",
    "level": "a7",
    "prefabRef": "a7_template_move"
  },
  {
    "key": "a8",
    "parent": "faceA",
    "title": "tutorial.a8Title",
    "content": "tutorial.a8Body",
    "role": "level",
    "level": "a8"
  },
  {
    "key": "a8_coffee",
    "parent": "a8",
    "title": "tutorial.a8_coffeeTitle",
    "content": "tutorial.a8_coffeeBody",
    "role": "practice",
    "level": "a8"
  },
  {
    "key": "faceB",
    "parent": "root",
    "title": "tutorial.faceBTitle",
    "content": "tutorial.faceBBody",
    "role": "face"
  },
  {
    "key": "b1",
    "parent": "faceB",
    "title": "tutorial.b1Title",
    "content": "tutorial.b1Body",
    "role": "level",
    "level": "b1",
    "images": [
      {
        "asset": "sunrise",
        "layout": "float",
        "width": 259,
        "height": 161.875,
        "x": 2,
        "y": 259.78125
      },
      {
        "asset": "night",
        "layout": "float",
        "width": 254,
        "height": 158.75,
        "x": 273,
        "y": 263.5
      }
    ]
  },
  {
    "key": "b1_layout",
    "parent": "b1",
    "title": "tutorial.b1_layoutTitle",
    "content": "tutorial.b1_layoutBody",
    "role": "step",
    "level": "b1",
    "images": [
      {
        "asset": "sunrise",
        "layout": "inline",
        "width": 210,
        "height": 132,
        "x": 22,
        "y": 235
      }
    ]
  },
  {
    "key": "b1_layers",
    "parent": "b1",
    "title": "tutorial.b1_layersTitle",
    "content": "tutorial.b1_layersBody",
    "role": "step",
    "level": "b1",
    "images": [
      {
        "asset": "sunrise",
        "layout": "overlay",
        "width": 220,
        "height": 138,
        "x": 40,
        "y": 250,
        "layer": 0
      },
      {
        "asset": "night",
        "layout": "overlay",
        "width": 220,
        "height": 138,
        "x": 120,
        "y": 310,
        "layer": 1
      }
    ]
  },
  {
    "key": "b1_gallery",
    "parent": "b1",
    "title": "tutorial.b1_galleryTitle",
    "content": "tutorial.b1_galleryBody",
    "role": "step",
    "level": "b1",
    "images": [
      {
        "asset": "sunrise",
        "layout": "inline",
        "width": 240,
        "height": 150
      },
      {
        "asset": "night",
        "layout": "inline",
        "width": 240,
        "height": 150
      }
    ]
  },
  {
    "key": "b2",
    "parent": "faceB",
    "title": "tutorial.b2Title",
    "content": "tutorial.b2Body",
    "role": "level",
    "level": "b2"
  },
  {
    "key": "b2_structure",
    "parent": "b2",
    "title": "tutorial.b2_structureTitle",
    "content": "tutorial.b2_structureBody",
    "role": "step",
    "level": "b2"
  },
  {
    "key": "b2_layout",
    "parent": "b2",
    "title": "tutorial.b2_layoutTitle",
    "content": "tutorial.b2_layoutBody",
    "role": "step",
    "level": "b2"
  },
  {
    "key": "b2_create",
    "parent": "b2",
    "title": "tutorial.b2_createTitle",
    "content": "tutorial.b2_createBody",
    "role": "step",
    "level": "b2"
  },
  {
    "key": "b3",
    "parent": "faceB",
    "title": "tutorial.b3Title",
    "content": "tutorial.b3Body",
    "role": "level",
    "level": "b3"
  },
  {
    "key": "b3_short",
    "parent": "b3",
    "title": "tutorial.b3_shortTitle",
    "content": "tutorial.b3_shortBody",
    "role": "step",
    "level": "b3"
  },
  {
    "key": "b3_long",
    "parent": "b3",
    "title": "tutorial.b3_longTitle",
    "content": "tutorial.b3_longBody",
    "role": "step",
    "level": "b3"
  },
  {
    "key": "b3_medium",
    "parent": "b3",
    "title": "tutorial.b3_mediumTitle",
    "content": "tutorial.b3_mediumBody",
    "role": "step",
    "level": "b3"
  },
  {
    "key": "b4",
    "parent": "faceB",
    "title": "tutorial.b4Title",
    "content": "tutorial.b4Body",
    "role": "level",
    "level": "b4",
    "images": [
      {
        "asset": "sunrise",
        "layout": "inline",
        "width": 240,
        "height": 150
      }
    ],
    "doodleAsset": "b4"
  },
  {
    "key": "b4_detail",
    "parent": "b4",
    "title": "tutorial.b4_detailTitle",
    "content": "tutorial.b4_detailBody",
    "role": "step",
    "level": "b4"
  },
  {
    "key": "b4_backup",
    "parent": "b4",
    "title": "tutorial.b4_backupTitle",
    "content": "tutorial.b4_backupBody",
    "role": "step",
    "level": "b4"
  },
  {
    "key": "b5",
    "parent": "faceB",
    "title": "tutorial.b5Title",
    "content": "tutorial.b5Body",
    "role": "level",
    "level": "b5"
  },
  {
    "key": "b5_protocol",
    "parent": "b5",
    "title": "tutorial.b5_protocolTitle",
    "content": "tutorial.b5_protocolBody",
    "role": "step",
    "level": "b5"
  },
  {
    "key": "b5_tools",
    "parent": "b5",
    "title": "tutorial.b5_toolsTitle",
    "content": "tutorial.b5_toolsBody",
    "role": "step",
    "level": "b5"
  },
  {
    "key": "b5_catalog",
    "parent": "b5",
    "title": "tutorial.b5_catalogTitle",
    "content": "tutorial.b5_catalogBody",
    "role": "step",
    "level": "b5"
  },
  {
    "key": "faceC",
    "parent": "root",
    "title": "tutorial.faceCTitle",
    "content": "tutorial.faceCBody",
    "role": "face"
  },
  {
    "key": "c1",
    "parent": "faceC",
    "title": "tutorial.c1Title",
    "content": "tutorial.c1Body",
    "role": "level",
    "level": "c1"
  },
  {
    "key": "c1_files",
    "parent": "c1",
    "title": "tutorial.c1_filesTitle",
    "content": "tutorial.c1_filesBody",
    "role": "step",
    "level": "c1"
  },
  {
    "key": "c1_palette",
    "parent": "c1",
    "title": "tutorial.c1_paletteTitle",
    "content": "tutorial.c1_paletteBody",
    "role": "step",
    "level": "c1"
  },
  {
    "key": "c1_typography",
    "parent": "c1",
    "title": "tutorial.c1_typographyTitle",
    "content": "tutorial.c1_typographyBody",
    "role": "step",
    "level": "c1"
  },
  {
    "key": "c1_resources",
    "parent": "c1",
    "title": "tutorial.c1_resourcesTitle",
    "content": "tutorial.c1_resourcesBody",
    "role": "step",
    "level": "c1"
  },
  {
    "key": "c1_check",
    "parent": "c1",
    "title": "tutorial.c1_checkTitle",
    "content": "tutorial.c1_checkBody",
    "role": "step",
    "level": "c1"
  },
  {
    "key": "c2",
    "parent": "faceC",
    "title": "tutorial.c2Title",
    "content": "tutorial.c2Body",
    "role": "level",
    "level": "c2"
  },
  {
    "key": "c2_api",
    "parent": "c2",
    "title": "tutorial.c2_apiTitle",
    "content": "tutorial.c2_apiBody",
    "role": "step",
    "level": "c2"
  },
  {
    "key": "c2_requests",
    "parent": "c2",
    "title": "tutorial.c2_requestsTitle",
    "content": "tutorial.c2_requestsBody",
    "role": "step",
    "level": "c2"
  },
  {
    "key": "c2_data",
    "parent": "c2",
    "title": "tutorial.c2_dataTitle",
    "content": "tutorial.c2_dataBody",
    "role": "step",
    "level": "c2"
  },
  {
    "key": "c2_tutorial",
    "parent": "c2",
    "title": "tutorial.c2_tutorialTitle",
    "content": "tutorial.c2_tutorialBody",
    "role": "step",
    "level": "c2"
  },
  {
    "key": "c2_check",
    "parent": "c2",
    "title": "tutorial.c2_checkTitle",
    "content": "tutorial.c2_checkBody",
    "role": "step",
    "level": "c2"
  },
  {
    "key": "faceD",
    "parent": "root",
    "title": "tutorial.faceDTitle",
    "content": "tutorial.faceDBody",
    "role": "face"
  },
  {
    "key": "a7_template",
    "parent": "003",
    "title": "tutorial.a7_templateTitle",
    "content": "tutorial.a7_templateBody",
    "role": "practice",
    "level": "a7",
    "isPrefab": true,
    "prefabBaseContent": "tutorial.a7_baselineBody"
  },
  {
    "key": "a7_template_create",
    "parent": "a7_template",
    "title": "tutorial.a7_template_createTitle",
    "content": "tutorial.a7_template_createBody",
    "role": "practice",
    "level": "a7",
    "isPrefab": true
  },
  {
    "key": "a7_template_instantiate",
    "parent": "a7_template",
    "title": "tutorial.a7_template_instantiateTitle",
    "content": "tutorial.a7_template_instantiateBody",
    "role": "practice",
    "level": "a7",
    "isPrefab": true
  },
  {
    "key": "a7_template_move",
    "parent": "a7_template",
    "title": "tutorial.a7_template_moveTitle",
    "content": "tutorial.a7_template_moveBody",
    "role": "practice",
    "level": "a7",
    "isPrefab": true
  }
];

export function extensionTutorialCards(extensions=AVAILABLE_EXTENSIONS):TutorialCardTemplate[]{
 return extensions.flatMap(extension=>extension.tutorial.cards.map(card=>({...card,
  key:`extension:${extension.id}:${card.key}`,
  parent:card.key===extension.tutorial.root?'faceD':`extension:${extension.id}:${card.parent}`,
  level:`extension:${extension.id}:${extension.tutorial.root}`,
  ...(card.prefabRef?{prefabRef:`extension:${extension.id}:${card.prefabRef}`}:{})
 })));
}
export const tutorialCards:readonly TutorialCardTemplate[]=[...coreCards,...extensionTutorialCards()];
